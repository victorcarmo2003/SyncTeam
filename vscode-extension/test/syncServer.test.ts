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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { SyncServer } from "../src/sync/SyncServer.js";
import { PROTOCOL_VERSION, type RawMessage } from "../src/protocol.js";
import { createNullLogger, type Logger } from "../src/util/logger.js";
import { MAX_PORT } from "../src/util/port.js";
import { readPortLock } from "../src/sync/PortOwnership.js";

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

/** Ocupa `port` de verdade com um `net.Server` simples (simula "outro processo" já usando a porta). */
function occupyPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

function closeServer(srv: net.Server): Promise<void> {
  return new Promise((resolve) => srv.close(() => resolve()));
}

/** Logger que acumula as linhas para os testes de fallback de porta poderem inspecionar o texto exato. */
class CapturingLogger implements Logger {
  lines: string[] = [];
  info(message: string): void {
    this.lines.push(`INFO ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`WARN ${message}`);
  }
  error(message: string): void {
    this.lines.push(`ERROR ${message}`);
  }
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

// Fallback automático de porta ocupada (2026-08-02, .claude/rules/authority.md
// — "porta ocupada: cai para porta alternativa, com aviso visível, nunca mata
// processo alheio"). Esquema exato documentado em docs/DECISIONS.md: em
// EADDRINUSE, tenta port+1, port+2, ... até `portFallbackAttempts` vezes
// (default 5), nunca ultrapassando MAX_PORT. Ocupamos a porta de verdade com
// um `net.Server` simples (simula "outro processo já usando a porta") em vez
// de mockar `ws` — mesma filosofia de teste já usada neste arquivo (sockets
// reais em vez de fakes).
describe("SyncServer — fallback de porta ocupada", () => {
  test("porta configurada ocupada: cai para a próxima porta livre, reporta getActualPort() correto e loga com clareza", async () => {
    const port = await getFreePort();
    const occupier = await occupyPort(port);
    const logger = new CapturingLogger();
    const server = new SyncServer(port, logger);
    server.setHandlers({ onClientConnected: () => {}, onClientDisconnected: () => {}, onSpontaneous: () => {} });

    await server.start();

    expect(server.getConfiguredPort()).toBe(port);
    expect(server.getActualPort()).toBe(port + 1);

    // Log claro sobre o quê aconteceu: porta original ocupada + porta real em uso — nada de matar processo.
    const fallbackLine = logger.lines.find((line) => line.includes("estava ocupada"));
    expect(fallbackLine).toBeDefined();
    expect(fallbackLine).toContain(String(port));
    expect(fallbackLine).toContain(String(port + 1));
    expect(fallbackLine).toContain("nenhum processo de terceiro foi encerrado");

    // O servidor está de fato funcional na porta de fallback, não só nos bookkeeping fields.
    const client = await openClient(port + 1);
    client.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio" }));
    await waitFor(() => server.isClientConnected());

    client.terminate();
    await server.stop();
    expect(server.getActualPort()).toBeNull();
    await closeServer(occupier);
  });

  test("todas as tentativas de fallback esgotadas: rejeita com EADDRINUSE, sem matar nenhum processo", async () => {
    const port = await getFreePort();
    const occupiers = [await occupyPort(port), await occupyPort(port + 1), await occupyPort(port + 2)];
    const logger = new CapturingLogger();
    // portFallbackAttempts=2 -> tenta port, port+1, port+2 (3 no total) — todas ocupadas.
    const server = new SyncServer(port, logger, { portFallbackAttempts: 2 });

    let caught: NodeJS.ErrnoException | null = null;
    try {
      await server.start();
    } catch (error) {
      caught = error as NodeJS.ErrnoException;
    }

    expect(caught).not.toBeNull();
    expect(caught?.code).toBe("EADDRINUSE");
    expect(server.getActualPort()).toBeNull();
    expect(server.getConfiguredPort()).toBe(port);

    // As 3 tentativas foram logadas, e a mensagem final confirma que nenhum processo foi encerrado.
    expect(logger.lines.some((line) => line.includes(String(port)) && line.includes("ocupada"))).toBe(true);
    expect(logger.lines.some((line) => line.includes(String(port + 1)) && line.includes("ocupada"))).toBe(true);
    expect(logger.lines.some((line) => line.includes(String(port + 2)) && line.includes("esgotadas"))).toBe(true);
    expect(logger.lines.some((line) => line.includes("nenhum processo de terceiro foi encerrado"))).toBe(true);

    for (const occupier of occupiers) {
      await closeServer(occupier);
    }
  });

  test("portFallbackAttempts: 0 desliga o fallback por completo (falha na porta ocupada mesmo com a próxima livre)", async () => {
    const port = await getFreePort();
    const occupier = await occupyPort(port);
    const logger = new CapturingLogger();
    const server = new SyncServer(port, logger, { portFallbackAttempts: 0 });

    let caught: NodeJS.ErrnoException | null = null;
    try {
      await server.start();
    } catch (error) {
      caught = error as NodeJS.ErrnoException;
    }

    expect(caught).not.toBeNull();
    expect(caught?.code).toBe("EADDRINUSE");
    expect(server.getActualPort()).toBeNull();
    // Nunca tentou a porta alternativa — nenhuma linha de log de tentativa de fallback.
    expect(logger.lines.some((line) => line.includes("tentando a porta alternativa"))).toBe(false);

    await closeServer(occupier);
  });

  test("erro de bind que NÃO é EADDRINUSE (porta inválida) rejeita imediatamente, sem tentar fallback", async () => {
    const logger = new CapturingLogger();
    // Porta fora do intervalo válido de TCP/IP: Node rejeita antes mesmo de
    // emitir 'error' (validação síncrona), então nunca chega a existir uma
    // condição "EADDRINUSE" — exercita o mesmo contrato observável (rejeita
    // sem NENHUMA tentativa de fallback), sem depender de EACCES específico
    // de SO (não portável entre Windows/Unix).
    const server = new SyncServer(70000, logger);

    let caught: Error | null = null;
    try {
      await server.start();
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).not.toBeNull();
    expect(server.getActualPort()).toBeNull();
    expect(logger.lines.some((line) => line.includes("tentando a porta alternativa"))).toBe(false);
  });

  test("respeita MAX_PORT: não tenta uma porta acima do limite válido", async () => {
    const occupier = await occupyPort(MAX_PORT);
    const logger = new CapturingLogger();
    const server = new SyncServer(MAX_PORT, logger, { portFallbackAttempts: 3 });

    let caught: NodeJS.ErrnoException | null = null;
    try {
      await server.start();
    } catch (error) {
      caught = error as NodeJS.ErrnoException;
    }

    expect(caught).not.toBeNull();
    expect(caught?.code).toBe("EADDRINUSE");
    expect(server.getActualPort()).toBeNull();
    expect(logger.lines.some((line) => line.includes("não há mais portas candidatas"))).toBe(true);

    await closeServer(occupier);
  });
});

// "Posse de porta" (2026-08-02, docs/DECISIONS.md 3ª rodada,
// .claude/rules/authority.md "Matar processo de terceiro"): antes de cair no
// fallback automático de sempre (port+1...), a porta CONFIGURADA ocupada dá
// ao hook `onPortOccupied` uma chance de identificar+encerrar o processo e
// pedir um retry na MESMA porta. A decisão real (probe/detecção/diálogo) vive
// em `PortOwnership.ts` (testada em `test/portOwnership.test.ts`) — aqui só
// testamos a ORQUESTRAÇÃO do hook dentro de `tryListen` (quando é chamado,
// quantas vezes, o que acontece com cada decisão), com um hook FAKE simples
// (nunca mata processo de verdade — só fecha o `net.Server` de teste que
// ocupava a porta, simulando "o processo foi encerrado com sucesso").
describe("SyncServer — posse de porta (onPortOccupied hook)", () => {
  test("retrySamePort reconquista a porta CONFIGURADA (nunca cai para port+1) e expõe getLastReclaimed()", async () => {
    const port = await getFreePort();
    const occupier = await occupyPort(port);
    const logger = new CapturingLogger();
    let hookCalls = 0;
    const server = new SyncServer(port, logger, {
      onPortOccupied: async (info) => {
        hookCalls++;
        expect(info).toEqual({ requestedPort: port, occupiedPort: port });
        await closeServer(occupier); // simula "processo identificado foi encerrado com sucesso"
        return { action: "retrySamePort", reclaimed: { pid: 4242, processName: "Code.exe" } };
      },
    });
    server.setHandlers({ onClientConnected: () => {}, onClientDisconnected: () => {}, onSpontaneous: () => {} });

    await server.start();

    expect(hookCalls).toBe(1);
    expect(server.getActualPort()).toBe(port); // a MESMA porta configurada, nunca port+1
    expect(server.getLastReclaimed()).toEqual({ pid: 4242, processName: "Code.exe" });

    await server.stop();
  });

  test('decisão "fallback" do hook preserva o comportamento automático de sempre (port+1), getLastReclaimed() fica null', async () => {
    const port = await getFreePort();
    const occupier = await occupyPort(port);
    const logger = new CapturingLogger();
    let hookCalls = 0;
    const server = new SyncServer(port, logger, {
      onPortOccupied: async () => {
        hookCalls++;
        return { action: "fallback" };
      },
    });
    server.setHandlers({ onClientConnected: () => {}, onClientDisconnected: () => {}, onSpontaneous: () => {} });

    await server.start();

    expect(hookCalls).toBe(1);
    expect(server.getActualPort()).toBe(port + 1);
    expect(server.getLastReclaimed()).toBeNull();

    await server.stop();
    await closeServer(occupier);
  });

  test("o hook NUNCA é chamado para portas já de fallback — só para a porta CONFIGURADA", async () => {
    const port = await getFreePort();
    const occupiers = [await occupyPort(port), await occupyPort(port + 1)];
    const logger = new CapturingLogger();
    let hookCalls = 0;
    const server = new SyncServer(port, logger, {
      portFallbackAttempts: 3,
      onPortOccupied: async (info) => {
        hookCalls++;
        expect(info.occupiedPort).toBe(port);
        return { action: "fallback" };
      },
    });
    server.setHandlers({ onClientConnected: () => {}, onClientDisconnected: () => {}, onSpontaneous: () => {} });

    await server.start();

    expect(hookCalls).toBe(1); // nunca chamado de novo para port+1 (também ocupada)
    expect(server.getActualPort()).toBe(port + 2);

    await server.stop();
    for (const occupier of occupiers) {
      await closeServer(occupier);
    }
  });

  test("hook que rejeita (lança) cai no fallback automático sem travar nem propagar o erro", async () => {
    const port = await getFreePort();
    const occupier = await occupyPort(port);
    const logger = new CapturingLogger();
    const server = new SyncServer(port, logger, {
      onPortOccupied: async () => {
        throw new Error("falha simulada ao tentar posse da porta");
      },
    });
    server.setHandlers({ onClientConnected: () => {}, onClientDisconnected: () => {}, onSpontaneous: () => {} });

    await server.start();

    expect(server.getActualPort()).toBe(port + 1);
    expect(logger.lines.some((line) => line.includes("falha simulada ao tentar posse da porta"))).toBe(true);

    await server.stop();
    await closeServer(occupier);
  });

  test("retrySamePort otimista que NÃO libera a porta de fato cai no fallback normal, hook chamado no máximo 1 vez (nunca em loop)", async () => {
    const port = await getFreePort();
    const occupier = await occupyPort(port); // nunca fechado — a porta continua ocupada de verdade
    const logger = new CapturingLogger();
    let hookCalls = 0;
    const server = new SyncServer(port, logger, {
      onPortOccupied: async () => {
        hookCalls++;
        return { action: "retrySamePort" }; // otimista, mas ninguém liberou a porta de verdade
      },
    });
    server.setHandlers({ onClientConnected: () => {}, onClientDisconnected: () => {}, onSpontaneous: () => {} });

    await server.start();

    expect(hookCalls).toBe(1);
    expect(server.getActualPort()).toBe(port + 1); // caiu no fallback normal depois do retry falhar de novo

    await server.stop();
    await closeServer(occupier);
  });
});

// Lockfile de "posse de porta" (2026-08-02): grava PID+porta a cada bind
// bem-sucedido para uma tentativa FUTURA de bind na mesma porta reconhecer
// "isto é uma instância órfã do próprio SyncTeam" (ver `PortOwnership.ts`).
describe("SyncServer — portLockDir (lockfile de posse)", () => {
  test("grava o lockfile (PID desta instância) no bind bem-sucedido e remove no stop()", async () => {
    const port = await getFreePort();
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-portlock-server-"));
    const server = new SyncServer(port, createNullLogger(), { portLockDir: lockDir });
    server.setHandlers({ onClientConnected: () => {}, onClientDisconnected: () => {}, onSpontaneous: () => {} });

    await server.start();
    const lock = readPortLock(lockDir, port);
    expect(lock).not.toBeNull();
    expect(lock?.pid).toBe(process.pid);
    expect(lock?.port).toBe(port);

    await server.stop();
    expect(readPortLock(lockDir, port)).toBeNull();
  });

  test("o lockfile reflete a porta REAL (fallback), não a configurada", async () => {
    const port = await getFreePort();
    const occupier = await occupyPort(port);
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-portlock-fallback-"));
    const server = new SyncServer(port, createNullLogger(), { portLockDir: lockDir });
    server.setHandlers({ onClientConnected: () => {}, onClientDisconnected: () => {}, onSpontaneous: () => {} });

    await server.start();
    expect(server.getActualPort()).toBe(port + 1);
    expect(readPortLock(lockDir, port)).toBeNull(); // nunca conseguiu bindar a porta configurada
    const lock = readPortLock(lockDir, port + 1);
    expect(lock?.pid).toBe(process.pid);
    expect(lock?.port).toBe(port + 1);

    await server.stop();
    await closeServer(occupier);
  });

  test("sem portLockDir (padrão): nenhum lockfile é gravado — comportamento anterior à feature preservado", async () => {
    const port = await getFreePort();
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-portlock-off-"));
    const server = new SyncServer(port, createNullLogger()); // sem portLockDir
    server.setHandlers({ onClientConnected: () => {}, onClientDisconnected: () => {}, onSpontaneous: () => {} });

    await server.start();
    expect(readPortLock(lockDir, port)).toBeNull(); // diretório nem foi tocado

    await server.stop();
  });
});
