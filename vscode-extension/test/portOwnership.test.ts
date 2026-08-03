// Testa `src/sync/PortOwnership.ts` — "posse de porta" (2026-08-02,
// docs/DECISIONS.md 3ª rodada / .claude/rules/authority.md). Mesma filosofia
// de teste do resto de `sync/`: sockets/processos REAIS (nunca mockar `ws`,
// nunca fingir um child_process) — lockfile num tmpdir real, um child_process
// de verdade para `isProcessAlive`, um `net.Server`/`SyncServer` real para
// `findProcessOnPort`/`probePortSignal`.

import { describe, test, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocket } from "ws";
import {
  writePortLock,
  readPortLock,
  removePortLock,
  isProcessAlive,
  findProcessOnPort,
  probePortSignal,
  attemptPortReclaim,
  type PortReclaimHost,
  type PortProbeSignal,
  type PortOwnerProcess,
  type PortLockInfo,
} from "../src/sync/PortOwnership.js";
import { SyncServer } from "../src/sync/SyncServer.js";
import { createNullLogger } from "../src/util/logger.js";
import { PROTOCOL_VERSION } from "../src/protocol.js";

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

// Rastreia as conexões aceitas por cada "occupier" de teste — necessário
// porque `net.Server.close()` só chama seu callback depois que TODAS as
// conexões existentes terminarem (mesmo comportamento documentado que já
// motivou o `stopSafetyTimeoutMs`/terminate() em `SyncServer.stop()`).
// Achado real ao escrever os testes de `probePortSignal`: quando a sonda
// (`ws`) chama `socket.terminate()` num handshake ainda pendente (o
// "occupier" é um `net.Server` puro que nunca responde), a conexão TCP do
// lado do "occupier" às vezes não termina a tempo por conta própria — sem
// destruir explicitamente o socket aceito aqui, `closeServer` ficava
// pendurado indefinidamente (só um problema do TEST HELPER, não do produto:
// `probePortSignal` em si já resolvia corretamente em ~300ms).
const occupierConnections = new WeakMap<net.Server, Set<net.Socket>>();

function occupyPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    const conns = new Set<net.Socket>();
    occupierConnections.set(srv, conns);
    srv.on("connection", (socket) => {
      conns.add(socket);
      socket.on("close", () => conns.delete(socket));
    });
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

function closeServer(srv: net.Server): Promise<void> {
  const conns = occupierConnections.get(srv);
  if (conns) {
    for (const socket of conns) {
      socket.destroy();
    }
  }
  return new Promise((resolve) => srv.close(() => resolve()));
}

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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ----------------------------------------------------------------- Lockfile

describe("PortOwnership — lockfile", () => {
  test("write/read/remove round-trip num tmpdir real", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-portlock-"));
    const info: PortLockInfo = { pid: 12345, port: 1400, startedAt: Date.now() };

    expect(readPortLock(dir, 1400)).toBeNull(); // nada gravado ainda

    writePortLock(dir, info);
    expect(readPortLock(dir, 1400)).toEqual(info);

    removePortLock(dir, 1400);
    expect(readPortLock(dir, 1400)).toBeNull();
  });

  test("readPortLock retorna null para arquivo ausente, JSON malformado, e formato inesperado", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-portlock-bad-"));
    expect(readPortLock(dir, 9999)).toBeNull(); // diretório existe, arquivo não

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "port-1500.json"), "{ isso não é JSON válido", "utf8");
    expect(readPortLock(dir, 1500)).toBeNull();

    fs.writeFileSync(path.join(dir, "port-1600.json"), JSON.stringify({ pid: "não é número" }), "utf8");
    expect(readPortLock(dir, 1600)).toBeNull();
  });

  test("writePortLock cria o diretório recursivamente se ainda não existir", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-portlock-mkdir-"));
    const nested = path.join(base, "a", "b", "c");
    writePortLock(nested, { pid: 1, port: 1400, startedAt: 1 });
    expect(readPortLock(nested, 1400)).toEqual({ pid: 1, port: 1400, startedAt: 1 });
  });

  test("removePortLock é idempotente (ENOENT não lança)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-portlock-rm-"));
    expect(() => removePortLock(dir, 4242)).not.toThrow();
  });
});

// ------------------------------------------------------------- isProcessAlive

describe("PortOwnership — isProcessAlive", () => {
  let child: ChildProcess | null = null;

  afterEach(() => {
    if (child && !child.killed) {
      try {
        process.kill(child.pid as number);
      } catch {
        // já morto — ok
      }
    }
    child = null;
  });

  test("true para um processo genuinamente vivo, false depois de encerrado", async () => {
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    const pid = child.pid as number;
    await waitFor(() => isProcessAlive(pid));
    expect(isProcessAlive(pid)).toBe(true);

    process.kill(pid);
    await waitFor(() => !isProcessAlive(pid));
    expect(isProcessAlive(pid)).toBe(false);
  });

  test("false para PID inválido/inexistente sem lançar", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-5)).toBe(false);
    expect(isProcessAlive(999999)).toBe(false);
  });
});

// ------------------------------------------------------------ findProcessOnPort

describe("PortOwnership — findProcessOnPort", () => {
  test("identifica o PID (o do próprio processo de teste) ouvindo numa porta real", async () => {
    const port = await getFreePort();
    const srv = await occupyPort(port);
    try {
      const owner = await findProcessOnPort(port);
      expect(owner).not.toBeNull();
      expect((owner as PortOwnerProcess).pid).toBe(process.pid);
    } finally {
      await closeServer(srv);
    }
  });

  test("retorna null para uma porta livre (nada ouvindo)", async () => {
    const port = await getFreePort();
    const owner = await findProcessOnPort(port);
    expect(owner).toBeNull();
  });
});

// ------------------------------------------------------------- probePortSignal

describe("PortOwnership — probePortSignal", () => {
  test('"busy": servidor SyncTeam com uma sessão JÁ ATIVA responde connectionRejected', async () => {
    const port = await getFreePort();
    const server = new SyncServer(port, createNullLogger());
    server.setHandlers({ onClientConnected: () => {}, onClientDisconnected: () => {}, onSpontaneous: () => {} });
    await server.start();

    const activeClient = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      activeClient.once("open", () => resolve());
      activeClient.once("error", reject);
    });
    activeClient.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio" }));
    await waitFor(() => server.isClientConnected());

    const signal = await probePortSignal(port);
    expect(signal).toBe("busy");

    // A sonda NUNCA deve ter virado "o cliente" desse servidor — só 1
    // conectado (o activeClient de verdade), nunca 2.
    expect(server.getConnectedCount()).toBe(1);

    activeClient.terminate();
    await server.stop();
  });

  test('"respondsWs": servidor SyncTeam SEM nenhum cliente conectado não rejeita, mas também não vira "o plugin" da sonda', async () => {
    const port = await getFreePort();
    const server = new SyncServer(port, createNullLogger());
    let connectedCount = 0;
    server.setHandlers({
      onClientConnected: () => {
        connectedCount++;
      },
      onClientDisconnected: () => {},
      onSpontaneous: () => {},
    });
    await server.start();

    const signal = await probePortSignal(port, 300);
    expect(signal).toBe("respondsWs");

    // Efeito colateral crítico verificado: a sonda NUNCA manda 'hello', então
    // NUNCA deveria ter disparado onClientConnected no servidor remoto — se
    // disparasse, um extension host real mostraria uma notificação falsa de
    // "plugin conectado" só por causa da sondagem.
    expect(connectedCount).toBe(0);
    expect(server.isClientConnected()).toBe(false);

    await server.stop();
  });

  test('"silent": porta ocupada por um servidor TCP qualquer (não-WebSocket)', async () => {
    const port = await getFreePort();
    const srv = await occupyPort(port);
    try {
      const signal = await probePortSignal(port, 300);
      expect(signal).toBe("silent");
    } finally {
      await closeServer(srv);
    }
  });

  test('"silent": porta livre (conexão recusada)', async () => {
    const port = await getFreePort();
    const signal = await probePortSignal(port, 300);
    expect(signal).toBe("silent");
  });
});

// ------------------------------------------------------------ attemptPortReclaim

/** Host de teste que captura a mensagem exibida e devolve uma resposta programável. */
class FakeReclaimHost implements PortReclaimHost {
  messages: string[] = [];
  infos: string[] = [];
  errors: string[] = [];
  confirmResult = false;
  confirmCalls = 0;

  async confirmKill(message: string): Promise<boolean> {
    this.confirmCalls++;
    this.messages.push(message);
    return this.confirmResult;
  }
  info(message: string): void {
    this.infos.push(message);
  }
  error(message: string): void {
    this.errors.push(message);
  }
}

describe("PortOwnership — attemptPortReclaim", () => {
  // Correção 2026-08-02 (pedido explícito do usuário, docs/DECISIONS.md "3ª
  // rodada", correção posterior mesma data): `"busy"` deixou de ser
  // short-circuit para fallback — mesmo uma sessão "ativa agora" no registro
  // do servidor remoto pode ser um processo fantasma que travou sem o
  // servidor ter notado a queda ainda (heartbeat não estourou). Os 4 testes
  // abaixo substituem o antigo teste único que afirmava `confirmCalls === 0`.
  test('signal "busy": AGORA continua o fluxo normal (findOwner/readLock é chamado) e SEMPRE mostra o diálogo, com a mensagem MAIS FORTE — usuário recusa', async () => {
    const host = new FakeReclaimHost();
    host.confirmResult = false;
    const decision = await attemptPortReclaim({
      requestedPort: 1400,
      occupiedPort: 1400,
      lockDir: "/nao-usado",
      host,
      probeSignal: async () => "busy",
      findOwner: async () => ({ pid: 4321, processName: "Code.exe" }),
      readLock: () => null,
    });

    expect(decision).toEqual({ action: "fallback" });
    expect(host.confirmCalls).toBe(1); // agora SEMPRE chama confirmKill, mesmo em "busy"
    expect(host.messages[0]).toContain("CONECTADA AGORA");
    expect(host.messages[0]).toContain("MUITO PROVÁVEL");
    expect(host.messages[0]).toContain("PERDA DE TRABALHO NÃO SALVO");
    expect(host.messages[0]).toContain("4321");
    expect(host.infos.some((m) => m.includes("optou por não encerrar"))).toBe(true);
  });

  test('signal "busy": usuário CONFIRMA mesmo com o aviso mais forte — mata o processo e reconquista a porta normalmente', async () => {
    const host = new FakeReclaimHost();
    host.confirmResult = true;
    const killed: Array<{ pid: number; signal?: string }> = [];
    const decision = await attemptPortReclaim({
      requestedPort: 1400,
      occupiedPort: 1400,
      lockDir: "/nao-usado",
      host,
      probeSignal: async () => "busy",
      findOwner: async () => ({ pid: 4321, processName: "Code.exe" }),
      readLock: () => null,
      killProcess: (pid, signal) => {
        killed.push({ pid, signal });
      },
      isPortFreeCheck: async () => true,
    });

    expect(decision).toEqual({ action: "retrySamePort", reclaimed: { pid: 4321, processName: "Code.exe" } });
    expect(host.confirmCalls).toBe(1);
    expect(killed).toEqual([{ pid: 4321, signal: undefined }]);
  });

  test('signal "busy" sem processo identificável (findOwner null, sem lockfile): ainda fallback SEM diálogo (nada concreto para oferecer)', async () => {
    const host = new FakeReclaimHost();
    const decision = await attemptPortReclaim({
      requestedPort: 1400,
      occupiedPort: 1400,
      lockDir: "/nao-usado",
      host,
      probeSignal: async () => "busy",
      findOwner: async () => null,
      readLock: () => null,
    });

    expect(decision).toEqual({ action: "fallback" });
    expect(host.confirmCalls).toBe(0);
    expect(host.infos.some((m) => m.includes("parece ATIVA agora"))).toBe(true);
  });

  test('signal "busy" prevalece sobre "zumbi identificado": mesmo com lockfile batendo com o PID detectado, usa a mensagem MAIS FORTE de "busy", não a de zumbi', async () => {
    const host = new FakeReclaimHost();
    host.confirmResult = false;
    const decision = await attemptPortReclaim({
      requestedPort: 1400,
      occupiedPort: 1400,
      lockDir: "/nao-usado",
      host,
      probeSignal: async () => "busy",
      findOwner: async () => ({ pid: 4242, processName: "Code.exe" }),
      readLock: () => ({ pid: 4242, port: 1400, startedAt: 1 }),
      isAlive: () => true,
    });

    expect(decision).toEqual({ action: "fallback" });
    expect(host.confirmCalls).toBe(1);
    expect(host.messages[0]).toContain("CONECTADA AGORA");
    expect(host.messages[0]).not.toContain("instância anterior do próprio SyncTeam");
  });

  test("zumbi identificado (lockfile vivo + SO concorda) — mensagem amigável, mata e confirma retrySamePort", async () => {
    const host = new FakeReclaimHost();
    host.confirmResult = true;
    const killed: Array<{ pid: number; signal?: string }> = [];
    let freeCheckCalls = 0;

    const decision = await attemptPortReclaim({
      requestedPort: 1400,
      occupiedPort: 1400,
      lockDir: "/nao-usado",
      host,
      probeSignal: async () => "silent",
      findOwner: async () => ({ pid: 4242, processName: "Code.exe" }),
      readLock: () => ({ pid: 4242, port: 1400, startedAt: 1 }),
      isAlive: () => true,
      killProcess: (pid, signal) => {
        killed.push({ pid, signal });
      },
      isPortFreeCheck: async () => {
        freeCheckCalls++;
        return true; // livre já na primeira checagem
      },
      waitFreeMs: 1000,
    });

    expect(decision).toEqual({ action: "retrySamePort", reclaimed: { pid: 4242, processName: "Code.exe" } });
    expect(host.confirmCalls).toBe(1);
    expect(host.messages[0]).toContain("instância anterior do próprio SyncTeam");
    expect(host.messages[0]).toContain("4242");
    expect(killed).toEqual([{ pid: 4242, signal: undefined }]);
    expect(freeCheckCalls).toBeGreaterThan(0);
  });

  test('signal "respondsWs" sem identificação por lockfile: mensagem com aviso extra ("PROVAVELMENTE uma sessão viva")', async () => {
    const host = new FakeReclaimHost();
    host.confirmResult = false; // usuário recusa
    const decision = await attemptPortReclaim({
      requestedPort: 1400,
      occupiedPort: 1400,
      lockDir: "/nao-usado",
      host,
      probeSignal: async () => "respondsWs",
      findOwner: async () => ({ pid: 555, processName: null }),
      readLock: () => null, // sem lockfile — não identificável como órfão
      isAlive: () => false,
    });

    expect(decision).toEqual({ action: "fallback" });
    expect(host.confirmCalls).toBe(1);
    expect(host.messages[0]).toContain("PROVAVELMENTE");
    expect(host.messages[0]).toContain("555");
    expect(host.infos.some((m) => m.includes("optou por não encerrar"))).toBe(true);
  });

  test("processo não identificado (silent, sem lockfile): mensagem genérica, ainda exige confirmação", async () => {
    const host = new FakeReclaimHost();
    host.confirmResult = true;
    const decision = await attemptPortReclaim({
      requestedPort: 1400,
      occupiedPort: 1400,
      lockDir: "/nao-usado",
      host,
      probeSignal: async () => "silent",
      findOwner: async () => ({ pid: 777, processName: "python.exe" }),
      readLock: () => null,
      isAlive: () => false,
      killProcess: () => {},
      isPortFreeCheck: async () => true,
    });

    expect(decision.action).toBe("retrySamePort");
    expect(host.messages[0]).toContain("não identificado como uma instância do SyncTeam");
    expect(host.messages[0]).toContain("python.exe");
  });

  test("nenhum processo identificável (findOwner null, sem lockfile): fallback sem NUNCA mostrar diálogo", async () => {
    const host = new FakeReclaimHost();
    const decision = await attemptPortReclaim({
      requestedPort: 1400,
      occupiedPort: 1400,
      lockDir: "/nao-usado",
      host,
      probeSignal: async () => "silent",
      findOwner: async () => null,
      readLock: () => null,
    });

    expect(decision).toEqual({ action: "fallback" });
    expect(host.confirmCalls).toBe(0);
  });

  test("usuário recusa: fallback, killProcess NUNCA chamado", async () => {
    const host = new FakeReclaimHost();
    host.confirmResult = false;
    let killCalled = false;
    const decision = await attemptPortReclaim({
      requestedPort: 1400,
      occupiedPort: 1400,
      lockDir: "/nao-usado",
      host,
      probeSignal: async () => "silent",
      findOwner: async () => ({ pid: 888, processName: null }),
      readLock: () => null,
      killProcess: () => {
        killCalled = true;
      },
    });

    expect(decision).toEqual({ action: "fallback" });
    expect(killCalled).toBe(false);
  });

  test("killProcess lança: fallback, erro logado", async () => {
    const host = new FakeReclaimHost();
    host.confirmResult = true;
    const decision = await attemptPortReclaim({
      requestedPort: 1400,
      occupiedPort: 1400,
      lockDir: "/nao-usado",
      host,
      probeSignal: async () => "silent",
      findOwner: async () => ({ pid: 999, processName: null }),
      readLock: () => null,
      killProcess: () => {
        throw new Error("sem permissão");
      },
    });

    expect(decision).toEqual({ action: "fallback" });
    expect(host.errors.some((m) => m.includes("sem permissão"))).toBe(true);
  });

  test("porta nunca libera dentro do prazo: escala para SIGKILL na metade do tempo, depois desiste (fallback)", async () => {
    const host = new FakeReclaimHost();
    host.confirmResult = true;
    const killed: Array<{ pid: number; signal?: string }> = [];
    const decision = await attemptPortReclaim({
      requestedPort: 1400,
      occupiedPort: 1400,
      lockDir: "/nao-usado",
      host,
      probeSignal: async () => "silent",
      findOwner: async () => ({ pid: 111, processName: null }),
      readLock: () => null,
      isAlive: () => true, // "ainda vivo" à checagem de escalada
      killProcess: (pid, signal) => {
        killed.push({ pid, signal });
      },
      isPortFreeCheck: async () => false, // nunca libera
      waitFreeMs: 300,
    });

    expect(decision).toEqual({ action: "fallback" });
    expect(host.errors.some((m) => m.includes("não foi liberada a tempo"))).toBe(true);
    // Primeira chamada = kill inicial (sem 2º argumento = SIGTERM implícito
    // do default real, mas aqui é só o fake capturando "undefined foi
    // passado"); pelo menos uma chamada subsequente deve escalar para
    // SIGKILL (>= em vez de === para não ser sensível a jitter de timer).
    expect(killed.length).toBeGreaterThanOrEqual(2);
    expect(killed[0].signal).toBeUndefined();
    expect(killed.some((k) => k.signal === "SIGKILL")).toBe(true);
  }, 2000);

  test("identificado como órfão mesmo quando o SO não detecta nada (findOwner null, lockfile vivo)", async () => {
    const host = new FakeReclaimHost();
    host.confirmResult = true;
    const decision = await attemptPortReclaim({
      requestedPort: 1400,
      occupiedPort: 1400,
      lockDir: "/nao-usado",
      host,
      probeSignal: async () => "silent",
      findOwner: async () => null, // SO (ex.: lsof ausente) não conseguiu detectar nada
      readLock: () => ({ pid: 321, port: 1400, startedAt: 1 }),
      isAlive: () => true,
      killProcess: () => {},
      isPortFreeCheck: async () => true,
    });

    expect(decision).toEqual({ action: "retrySamePort", reclaimed: { pid: 321, processName: null } });
    expect(host.messages[0]).toContain("instância anterior do próprio SyncTeam");
  });

  test("lockfile aponta um PID vivo, mas o SO detecta um PID DIFERENTE ouvindo — não confia cegamente no lockfile (trata como não identificado)", async () => {
    const host = new FakeReclaimHost();
    host.confirmResult = true;
    const decision = await attemptPortReclaim({
      requestedPort: 1400,
      occupiedPort: 1400,
      lockDir: "/nao-usado",
      host,
      probeSignal: async () => "silent",
      findOwner: async () => ({ pid: 555, processName: "outro.exe" }), // o SO diz que É este quem ouve agora
      readLock: () => ({ pid: 999, port: 1400, startedAt: 1 }), // lockfile é de um PID diferente (stale)
      isAlive: (pid) => pid === 999, // o pid do lockfile até está "vivo", mas não é quem ocupa a porta
      killProcess: () => {},
      isPortFreeCheck: async () => true,
    });

    // Usa o PID que o SO de fato observou (555), não o do lockfile (999), e
    // NÃO trata como "instância anterior do próprio SyncTeam" (mensagem genérica).
    expect(decision).toEqual({ action: "retrySamePort", reclaimed: { pid: 555, processName: "outro.exe" } });
    expect(host.messages[0]).toContain("555");
    expect(host.messages[0]).not.toContain("instância anterior do próprio SyncTeam");
  });
});
