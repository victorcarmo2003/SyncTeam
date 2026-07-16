// Testa o feedback visível dos comandos de ciclo de vida (start/stop/restart/
// setPort) do SyncController — sucesso, falha (com motivo) e casos idempotentes.
// Bug do usuário: rodar "Iniciar servidor" pelo Command Palette não confirmava
// nada visível (sucesso OU falha só iam para o Output). O controlador roteia
// toda mensagem por `host.info`/`host.error`, então o FakeHost aqui captura
// exatamente o que o usuário veria via showInformationMessage/showErrorMessage,
// sem tocar `vscode`.

import { describe, test, expect, beforeEach } from "vitest";
import {
  SyncController,
  type SyncControllerHost,
  type StartServiceResult,
} from "../src/SyncController.js";
import { createNullLogger } from "../src/util/logger.js";

class FakeHost implements SyncControllerHost {
  // Feedback visível capturado (o que o usuário veria em popups).
  infos: string[] = [];
  errors: string[] = [];

  // Estado configurável do "mundo VS Code".
  configuredPort = 1400;
  clientConnected = false;
  promptResult: string | undefined = undefined;

  // Controle do resultado de startService.
  nextStartResult: StartServiceResult = { ok: true };
  startThrows: Error | null = null;

  // Contadores para asserções de idempotência.
  startCalls = 0;
  stopCalls = 0;
  setPortCalls: number[] = [];

  async startService(port: number): Promise<StartServiceResult> {
    this.startCalls += 1;
    if (this.startThrows) {
      throw this.startThrows;
    }
    // Simula o servidor de fato ouvindo na porta pedida quando ok.
    void port;
    return this.nextStartResult;
  }

  async stopService(): Promise<void> {
    this.stopCalls += 1;
  }

  isClientConnected(): boolean {
    return this.clientConnected;
  }

  getConfiguredPort(): number {
    return this.configuredPort;
  }

  async setConfiguredPort(port: number): Promise<void> {
    this.setPortCalls.push(port);
    this.configuredPort = port;
  }

  async promptForPort(_currentPort: number): Promise<string | undefined> {
    return this.promptResult;
  }

  info(message: string): void {
    this.infos.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }
}

function makeController(host: FakeHost): SyncController {
  return new SyncController(host, createNullLogger());
}

describe("SyncController — feedback visível de start", () => {
  let host: FakeHost;
  let controller: SyncController;

  beforeEach(() => {
    host = new FakeHost();
    controller = makeController(host);
  });

  test("start com sucesso mostra info message com a porta configurada", async () => {
    host.configuredPort = 4321;
    host.nextStartResult = { ok: true };

    await controller.start();

    expect(host.errors).toHaveLength(0);
    expect(host.infos).toHaveLength(1);
    expect(host.infos[0]).toContain("iniciado");
    expect(host.infos[0]).toContain("4321");
    expect(controller.getConnectionState().running).toBe(true);
    expect(controller.getConnectionState().port).toBe(4321);
  });

  test("start que falha mostra error message com o motivo, não info", async () => {
    host.nextStartResult = { ok: false, reason: "EADDRINUSE porta 1400 em uso" };

    await controller.start();

    expect(host.infos).toHaveLength(0);
    expect(host.errors).toHaveLength(1);
    expect(host.errors[0]).toContain("falha ao iniciar");
    expect(host.errors[0]).toContain("EADDRINUSE porta 1400 em uso");
    expect(controller.getConnectionState().running).toBe(false);
  });

  test("start que lança exceção vira falha anunciada (não Promise rejeitada)", async () => {
    host.startThrows = new Error("bind explodiu");

    // Não deve rejeitar — a cadeia do comando não pode terminar em silêncio.
    await expect(controller.start()).resolves.toBeUndefined();

    expect(host.infos).toHaveLength(0);
    expect(host.errors).toHaveLength(1);
    expect(host.errors[0]).toContain("falha ao iniciar");
    expect(host.errors[0]).toContain("bind explodiu");
    expect(controller.getConnectionState().running).toBe(false);
  });

  test("start já rodando (idempotente) avisa que já está rodando na porta e não reinicia", async () => {
    host.configuredPort = 5000;
    await controller.start(); // sobe
    host.infos.length = 0; // zera para observar só a 2ª chamada

    await controller.start(); // já rodando

    expect(host.startCalls).toBe(1); // não chamou startService de novo
    expect(host.errors).toHaveLength(0);
    expect(host.infos).toHaveLength(1);
    expect(host.infos[0]).toContain("já está rodando");
    expect(host.infos[0]).toContain("5000");
  });

  test("autostart (announce:false) sobe sem popar nenhuma mensagem", async () => {
    host.nextStartResult = { ok: true };

    await controller.start({ announce: false });

    expect(host.infos).toHaveLength(0);
    expect(host.errors).toHaveLength(0);
    expect(controller.getConnectionState().running).toBe(true);
  });

  test("autostart (announce:false) que falha também fica silencioso", async () => {
    host.nextStartResult = { ok: false, reason: "sem default.project.json" };

    await controller.start({ announce: false });

    expect(host.infos).toHaveLength(0);
    expect(host.errors).toHaveLength(0);
    expect(controller.getConnectionState().running).toBe(false);
  });
});

describe("SyncController — feedback visível de stop", () => {
  let host: FakeHost;
  let controller: SyncController;

  beforeEach(() => {
    host = new FakeHost();
    controller = makeController(host);
  });

  test("stop com sucesso mostra 'servidor parado'", async () => {
    await controller.start(); // precisa estar rodando
    host.infos.length = 0;

    await controller.stop();

    expect(host.stopCalls).toBe(1);
    expect(host.infos).toHaveLength(1);
    expect(host.infos[0]).toContain("parado");
    expect(controller.getConnectionState().running).toBe(false);
  });

  test("stop já parado (idempotente) avisa 'já está parado' e não chama stopService", async () => {
    await controller.stop(); // nunca subiu

    expect(host.stopCalls).toBe(0);
    expect(host.infos).toHaveLength(1);
    expect(host.infos[0]).toContain("já está parado");
  });
});

describe("SyncController — feedback visível de restart", () => {
  let host: FakeHost;
  let controller: SyncController;

  beforeEach(() => {
    host = new FakeHost();
    controller = makeController(host);
  });

  test("restart com sucesso anuncia o servidor iniciado na porta", async () => {
    host.configuredPort = 6001;

    await controller.restart();

    expect(host.stopCalls).toBe(1);
    expect(host.errors).toHaveLength(0);
    expect(host.infos.some((m) => m.includes("iniciado") && m.includes("6001"))).toBe(true);
    expect(controller.getConnectionState().running).toBe(true);
  });

  test("restart cujo start falha mostra error com o motivo", async () => {
    host.nextStartResult = { ok: false, reason: "porta ocupada" };

    await controller.restart();

    expect(host.infos).toHaveLength(0);
    expect(host.errors).toHaveLength(1);
    expect(host.errors[0]).toContain("porta ocupada");
    expect(controller.getConnectionState().running).toBe(false);
  });
});

describe("SyncController — feedback visível de setPort", () => {
  let host: FakeHost;
  let controller: SyncController;

  beforeEach(() => {
    host = new FakeHost();
    controller = makeController(host);
  });

  test("setPort válido persiste a porta e o restart subsequente anuncia sucesso", async () => {
    host.configuredPort = 1400;
    host.promptResult = "2500";

    await controller.setPort();

    expect(host.setPortCalls).toEqual([2500]);
    expect(host.errors).toHaveLength(0);
    expect(host.infos.some((m) => m.includes("iniciado") && m.includes("2500"))).toBe(true);
    expect(controller.getConnectionState().port).toBe(2500);
  });

  test("setPort válido cujo restart falha não termina em silêncio (mostra error)", async () => {
    host.promptResult = "2500";
    host.nextStartResult = { ok: false, reason: "2500 em uso" };

    await controller.setPort();

    expect(host.setPortCalls).toEqual([2500]);
    expect(host.infos).toHaveLength(0);
    expect(host.errors).toHaveLength(1);
    expect(host.errors[0]).toContain("falha ao iniciar");
    expect(host.errors[0]).toContain("2500 em uso");
  });

  test("setPort cancelado/ inválido não altera config nem mostra mensagem", async () => {
    host.promptResult = undefined; // Escape no input box

    await controller.setPort();

    expect(host.setPortCalls).toHaveLength(0);
    expect(host.infos).toHaveLength(0);
    expect(host.errors).toHaveLength(0);
    expect(host.startCalls).toBe(0);
  });
});
