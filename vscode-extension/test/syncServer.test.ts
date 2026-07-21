// Testa o SyncServer com um "plugin fake" — um cliente ws de verdade em
// 127.0.0.1 que fica no lugar do plugin Studio. Timers reais e curtos
// (intervalo 30ms / timeout 90ms) para o ciclo de heartbeat rodar em ~150ms.
//
// Foco: confirmar de ponta a ponta que "o estado vira desconectado" quando o
// plugin para de responder aos pings SEM mandar frame de close (o cenário do
// bug: processo morto sem handshake de close) — e que pong mantém a conexão
// viva sem virar mensagem espontânea. Também cobre a rejeição por
// protocolVersion incompatível disparando onProtocolError.

import { describe, test, expect } from "vitest";
import net from "node:net";
import { WebSocket } from "ws";
import { SyncServer } from "../src/sync/SyncServer.js";
import { PROTOCOL_VERSION, type RawMessage } from "../src/protocol.js";
import { createNullLogger } from "../src/util/logger.js";

/** Pega uma porta TCP livre pedindo ao SO uma efêmera e fechando em seguida. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (condition()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error("waitFor: condição não satisfeita no tempo"));
      }
    }, 5);
  });
}

function openClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    client.once("open", () => resolve(client));
    client.once("error", reject);
  });
}

describe("SyncServer — heartbeat", () => {
  test("plugin que para de responder é desconectado mesmo sem frame de close", async () => {
    const port = await getFreePort();
    const server = new SyncServer(port, createNullLogger(), { heartbeatIntervalMs: 30, heartbeatTimeoutMs: 90 });
    let connected = 0;
    let disconnected = 0;
    server.setHandlers({
      onClientConnected: () => {
        connected++;
      },
      onClientDisconnected: () => {
        disconnected++;
      },
      onSpontaneous: () => {},
    });
    await server.start();

    // Cliente "plugin morto": manda hello e depois IGNORA todos os pings —
    // nunca responde e nunca fecha o socket de propósito.
    const client = await openClient(port);
    client.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio" }));

    await waitFor(() => connected === 1);
    expect(server.isClientConnected()).toBe(true);

    // O socket TCP continua "aberto" do lado do cliente; só o heartbeat detecta
    // o silêncio e derruba a conexão.
    await waitFor(() => disconnected === 1);
    expect(server.isClientConnected()).toBe(false);

    client.terminate();
    await server.stop();
  });

  test("pong mantém a conexão viva, o ping é enviado ao plugin, e o pong não vira mensagem espontânea", async () => {
    const port = await getFreePort();
    const server = new SyncServer(port, createNullLogger(), { heartbeatIntervalMs: 30, heartbeatTimeoutMs: 90 });
    const spontaneous: RawMessage[] = [];
    let disconnected = 0;
    server.setHandlers({
      onClientConnected: () => {},
      onClientDisconnected: () => {
        disconnected++;
      },
      onSpontaneous: (message) => spontaneous.push(message),
    });
    await server.start();

    const client = await openClient(port);
    let pingsReceived = 0;
    client.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString());
      if (message.kind === "ping") {
        pingsReceived++;
        client.send(JSON.stringify({ kind: "pong" }));
      }
    });
    client.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio" }));

    // Deixa vários ciclos de heartbeat correrem (bem além do timeout de 90ms).
    await delay(300);

    expect(pingsReceived).toBeGreaterThan(0); // a extensão manda ping de fato
    expect(server.isClientConnected()).toBe(true); // pong manteve a conexão viva
    expect(disconnected).toBe(0);
    // pong é engolido: nunca chega ao roteador de mensagens espontâneas.
    expect(spontaneous.some((message) => message.kind === "pong")).toBe(false);

    client.terminate();
    await server.stop();
  });

  test("segunda conexão recebe connectionRejected ANTES do close", async () => {
    const port = await getFreePort();
    const server = new SyncServer(port, createNullLogger());
    let connected = 0;
    server.setHandlers({
      onClientConnected: () => {
        connected++;
      },
      onClientDisconnected: () => {},
      onSpontaneous: () => {},
    });
    await server.start();

    // Primeiro plugin: conecta e vira o dono da conexão.
    const first = await openClient(port);
    first.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio" }));
    await waitFor(() => connected === 1);

    // Segundo plugin: registra a ORDEM dos eventos (mensagem vs. close) para
    // provar que o connectionRejected chega antes do fechamento — o plugin
    // real depende disso porque não lê o close code. Os listeners são anexados
    // na CONSTRUÇÃO (antes de "open") para não perder o frame de rejeição numa
    // corrida entre a resolução de "open" e a chegada da mensagem.
    const events: string[] = [];
    let rejected: RawMessage | null = null;
    let closeCode = 0;
    const second = new WebSocket(`ws://127.0.0.1:${port}`);
    second.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString()) as RawMessage;
      if (message.kind === "connectionRejected") {
        rejected = message;
        events.push("message");
      }
    });
    second.on("close", (code: number) => {
      closeCode = code;
      events.push("close");
    });

    await waitFor(() => events.includes("close"));

    // A mensagem chegou, com o reason esperado, e ANTES do close.
    expect(rejected).not.toBeNull();
    expect((rejected as unknown as RawMessage).reason).toBe("port_in_use");
    expect(events[0]).toBe("message");
    expect(events).toEqual(["message", "close"]);
    expect(closeCode).toBe(1013);

    // O primeiro plugin continua sendo o cliente conectado — não foi substituído.
    expect(server.isClientConnected()).toBe(true);
    expect(connected).toBe(1);

    first.terminate();
    second.terminate();
    await server.stop();
  });

  test("protocolVersion incompatível dispara onProtocolError e fecha com 1002", async () => {
    const port = await getFreePort();
    const server = new SyncServer(port, createNullLogger());
    let connected = 0;
    let protocolError: string | null = null;
    server.setHandlers({
      onClientConnected: () => {
        connected++;
      },
      onClientDisconnected: () => {},
      onSpontaneous: () => {},
      onProtocolError: (message) => {
        protocolError = message;
      },
    });
    await server.start();

    const client = await openClient(port);
    let closeCode = 0;
    client.on("close", (code: number) => {
      closeCode = code;
    });
    client.send(JSON.stringify({ kind: "hello", protocolVersion: 999, role: "studio" }));

    await waitFor(() => protocolError !== null);
    expect(protocolError).not.toBeNull();
    expect(protocolError as unknown as string).toContain("incompatível");
    expect(connected).toBe(0); // nunca foi aceito como conectado

    await waitFor(() => closeCode === 1002);
    expect(server.isClientConnected()).toBe(false);

    await server.stop();
  });
});

// stop() robustez (2026-07-20): bug relatado pelo usuário — ao fechar o VS
// Code com o servidor ativo, o processo do extension host não morria e a
// porta continuava em uso. Causa raiz confirmada lendo o código-fonte do
// `ws` vendorizado (node_modules/ws): client.close() inicia um handshake
// gracioso que só destrói o socket depois de até 30s (CLOSE_TIMEOUT interno)
// se o peer nunca responder, e wss.close() (modo `port`) só chama o callback
// quando NENHUMA conexão TCP residual continuar aberta. Testa exatamente o
// cenário: um "plugin morto" conectado que nunca fecha nem responde, e
// confirma que stop() ainda assim resolve rápido E a porta é liberada de
// verdade pelo SO (outro processo consegue bindar nela imediatamente depois).
describe("SyncServer — stop() robustez", () => {
  test("stop() resolve rapidamente e libera a porta mesmo com o socket do plugin morto/sem resposta", async () => {
    const port = await getFreePort();
    const server = new SyncServer(port, createNullLogger());
    server.setHandlers({ onClientConnected: () => {}, onClientDisconnected: () => {}, onSpontaneous: () => {} });
    await server.start();

    const client = await openClient(port);
    client.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio" }));
    await waitFor(() => server.isClientConnected());

    // Não chamamos client.close()/terminate() aqui de propósito: o socket
    // fica "pendurado" exatamente como no cenário do bug relatado (plugin
    // morto ou rede quebrada sem RST) — nenhum aviso de close chega, e o
    // cliente nunca responde a nada.
    const start = Date.now();
    await server.stop();
    const elapsed = Date.now() - start;
    // Bem abaixo do CLOSE_TIMEOUT de 30000ms do `ws` — prova que não caiu no
    // caminho antigo (client.close() esperando o handshake gracioso).
    expect(elapsed).toBeLessThan(1000);

    // A porta foi de fato liberada pelo SO: outro listener consegue bindar
    // nela imediatamente, sem EADDRINUSE.
    await new Promise<void>((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
    });

    client.terminate();
  });

  test("stop() com múltiplos sockets mortos (multiSync) também resolve rápido e libera a porta", async () => {
    const port = await getFreePort();
    const server = new SyncServer(port, createNullLogger(), { multiSync: true });
    server.setHandlers({ onClientConnected: () => {}, onClientDisconnected: () => {}, onSpontaneous: () => {} });
    await server.start();

    const first = await openClient(port);
    const second = await openClient(port);
    first.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio", clientId: "A" }));
    second.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio", clientId: "B" }));
    await waitFor(() => server.getConnectedCount() === 2);

    // Os dois ficam mudos/pendurados — nenhum fecha de propósito.
    const start = Date.now();
    await server.stop();
    expect(Date.now() - start).toBeLessThan(1000);

    await new Promise<void>((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
    });

    first.terminate();
    second.terminate();
  });
});

// multiSync (2026-07-15): permite N plugins conectados na mesma porta. Testa
// que (a) 2 clientes conectam ao mesmo tempo sem rejeição, (b) mensagens de
// saída são BROADCAST para todos, (c) request() resolve na PRIMEIRA resposta
// e ignora as demais sem erro, (d) desconectar 1 não afeta o outro.
describe("SyncServer — multiSync", () => {
  test("2 plugins conectam ao mesmo tempo (nenhum rejeitado) e isClientConnected/getConnectedCount refletem os 2", async () => {
    const port = await getFreePort();
    const server = new SyncServer(port, createNullLogger(), { multiSync: true });
    let connected = 0;
    server.setHandlers({
      onClientConnected: () => {
        connected++;
      },
      onClientDisconnected: () => {},
      onSpontaneous: () => {},
    });
    await server.start();

    const first = await openClient(port);
    first.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio", clientId: "A" }));
    const second = await openClient(port);
    second.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio", clientId: "B" }));

    await waitFor(() => connected === 2);
    expect(server.isClientConnected()).toBe(true);
    expect(server.getConnectedCount()).toBe(2);

    first.terminate();
    second.terminate();
    await server.stop();
  });

  test("mensagem de saída (sendSpontaneous) é recebida por AMBOS os clientes conectados", async () => {
    const port = await getFreePort();
    const server = new SyncServer(port, createNullLogger(), { multiSync: true });
    server.setHandlers({ onClientConnected: () => {}, onClientDisconnected: () => {}, onSpontaneous: () => {} });
    await server.start();

    const first = await openClient(port);
    const second = await openClient(port);
    const firstMessages: RawMessage[] = [];
    const secondMessages: RawMessage[] = [];
    first.on("message", (data: Buffer) => firstMessages.push(JSON.parse(data.toString())));
    second.on("message", (data: Buffer) => secondMessages.push(JSON.parse(data.toString())));
    first.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio" }));
    second.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio" }));

    await waitFor(() => server.getConnectedCount() === 2);

    server.sendSpontaneous({ kind: "presenceUpdate", uuid: "uuid-1" });

    await waitFor(() => firstMessages.some((m) => m.kind === "presenceUpdate") && secondMessages.some((m) => m.kind === "presenceUpdate"));
    expect(firstMessages.some((m) => m.kind === "presenceUpdate" && m.uuid === "uuid-1")).toBe(true);
    expect(secondMessages.some((m) => m.kind === "presenceUpdate" && m.uuid === "uuid-1")).toBe(true);

    first.terminate();
    second.terminate();
    await server.stop();
  });

  test("request() broadcast para os 2 clientes resolve na PRIMEIRA resposta e ignora a 2ª sem erro", async () => {
    const port = await getFreePort();
    const server = new SyncServer(port, createNullLogger(), { multiSync: true });
    const spontaneous: RawMessage[] = [];
    server.setHandlers({
      onClientConnected: () => {},
      onClientDisconnected: () => {},
      onSpontaneous: (message) => spontaneous.push(message),
    });
    await server.start();

    const first = await openClient(port);
    const second = await openClient(port);
    // Ambos os plugins recebem o mesmo requestId (broadcast) e respondem —
    // "second" responde mais devagar de propósito para "first" ganhar.
    first.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString()) as RawMessage;
      if (message.kind === "readSource") {
        first.send(JSON.stringify({ kind: "sourceContent", requestId: message.requestId, ok: true, source: "do primeiro" }));
      }
    });
    second.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString()) as RawMessage;
      if (message.kind === "readSource") {
        setTimeout(() => {
          second.send(JSON.stringify({ kind: "sourceContent", requestId: message.requestId, ok: true, source: "do segundo" }));
        }, 30);
      }
    });
    first.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio" }));
    second.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio" }));
    await waitFor(() => server.getConnectedCount() === 2);

    const response = await server.request({ kind: "readSource", uuid: "uuid-1" });
    expect(response.source).toBe("do primeiro");

    // Dá tempo da resposta atrasada do segundo cliente chegar — não deve
    // lançar nem travar; cai em onSpontaneous e é só descartada (kind
    // desconhecido para o roteador de espontâneas, sem pending mais).
    await delay(100);
    expect(spontaneous.some((m) => m.kind === "sourceContent" && m.source === "do segundo")).toBe(true);

    first.terminate();
    second.terminate();
    await server.stop();
  });

  test("desconectar 1 dos 2 clientes não derruba o outro nem reseta o estado do servidor", async () => {
    const port = await getFreePort();
    const server = new SyncServer(port, createNullLogger(), { multiSync: true });
    let disconnected = 0;
    server.setHandlers({
      onClientConnected: () => {},
      onClientDisconnected: () => {
        disconnected++;
      },
      onSpontaneous: () => {},
    });
    await server.start();

    const first = await openClient(port);
    const second = await openClient(port);
    first.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio" }));
    second.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio" }));
    await waitFor(() => server.getConnectedCount() === 2);

    first.close();
    await waitFor(() => disconnected === 1);

    expect(server.getConnectedCount()).toBe(1);
    expect(server.isClientConnected()).toBe(true);

    second.terminate();
    await server.stop();
  });
});
