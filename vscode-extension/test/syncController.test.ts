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

// Fallback automático de porta ocupada (2026-08-02, .claude/rules/authority.md):
// quando startService() reporta uma actualPort diferente da pedida, o
// controlador precisa (a) anunciar isso de forma clara e diferente do sucesso
// normal, (b) atualizar getConnectionState().port para a porta REAL (é o que
// a status bar/ui-dev consulta), e (c) expor portFallbackFrom para quem quiser
// destacar a diferença.
describe("SyncController — fallback automático de porta ocupada", () => {
  let host: FakeHost;
  let controller: SyncController;

  beforeEach(() => {
    host = new FakeHost();
    controller = makeController(host);
  });

  test("start com fallback: anuncia a porta original ocupada e a porta real, e getConnectionState reflete a porta real", async () => {
    host.configuredPort = 1400;
    host.nextStartResult = { ok: true, actualPort: 1401 };

    await controller.start();

    expect(host.errors).toHaveLength(0);
    expect(host.infos).toHaveLength(1);
    expect(host.infos[0]).toContain("1400");
    expect(host.infos[0]).toContain("1401");
    expect(host.infos[0]).toContain("ocupada");

    const state = controller.getConnectionState();
    expect(state.running).toBe(true);
    expect(state.port).toBe(1401); // a porta REAL, não a configurada
    expect(state.portFallbackFrom).toBe(1400);
  });

  test("start sem fallback (actualPort igual à pedida, ou ausente): mensagem normal, sem portFallbackFrom", async () => {
    host.configuredPort = 1400;
    host.nextStartResult = { ok: true, actualPort: 1400 }; // host devolveu explicitamente igual à pedida

    await controller.start();

    expect(host.infos[0]).toContain("iniciado na porta 1400");
    expect(host.infos[0]).not.toContain("ocupada");
    expect(controller.getConnectionState().port).toBe(1400);
    expect(controller.getConnectionState().portFallbackFrom).toBeUndefined();
  });

  test("start que falha nunca define portFallbackFrom", async () => {
    host.nextStartResult = { ok: false, reason: "todas as portas ocupadas" };

    await controller.start();

    expect(controller.getConnectionState().portFallbackFrom).toBeUndefined();
  });

  test("restart com fallback também anuncia e atualiza a porta real", async () => {
    host.configuredPort = 2000;
    host.nextStartResult = { ok: true, actualPort: 2003 };

    await controller.restart();

    expect(host.infos.some((m) => m.includes("2000") && m.includes("2003"))).toBe(true);
    expect(controller.getConnectionState().port).toBe(2003);
    expect(controller.getConnectionState().portFallbackFrom).toBe(2000);
  });

  test("um start com fallback seguido de outro SEM fallback limpa portFallbackFrom", async () => {
    host.configuredPort = 1400;
    host.nextStartResult = { ok: true, actualPort: 1401 };
    await controller.start();
    expect(controller.getConnectionState().portFallbackFrom).toBe(1400);

    await controller.stop();
    host.nextStartResult = { ok: true }; // porta livre desta vez, sem fallback
    await controller.start();

    expect(controller.getConnectionState().portFallbackFrom).toBeUndefined();
    expect(controller.getConnectionState().port).toBe(1400);
  });

  // Bug real achado pelo code-reviewer (2026-08-02, rodando teste de verdade,
  // não só leitura de código): stop() zerava `running` mas nunca recalculava
  // currentPort/portFallbackFrom de volta para a porta CONFIGURADA — depois de
  // um start com fallback seguido de stop(), getConnectionState() continuava
  // devolvendo a porta de fallback com running:false, contradizendo o próprio
  // doc-comment de ConnectionState.port ("enquanto parado, é a última porta
  // CONFIGURADA lida").
  test("start com fallback seguido de stop: getConnectionState volta para a porta CONFIGURADA, sem portFallbackFrom", async () => {
    host.configuredPort = 1400;
    host.nextStartResult = { ok: true, actualPort: 1401 };
    await controller.start();
    expect(controller.getConnectionState()).toMatchObject({
      running: true,
      port: 1401,
      portFallbackFrom: 1400,
    });

    await controller.stop();

    expect(controller.getConnectionState()).toMatchObject({
      running: false,
      port: 1400, // a porta CONFIGURADA original, não a de fallback
    });
    expect(controller.getConnectionState().portFallbackFrom).toBeUndefined();
  });
});

// "Posse de porta" (2026-08-02, docs/DECISIONS.md 3ª rodada,
// .claude/rules/authority.md "Matar processo de terceiro"): quando o host
// reporta `portReclaimed` (um processo foi identificado e encerrado com
// sucesso para liberar a porta CONFIGURADA), o controlador mostra uma
// mensagem DISTINTA da de fallback — o servidor está na porta ORIGINALMENTE
// pedida (nunca numa alternativa), então "fallback automático" seria
// enganoso aqui.
describe("SyncController — posse de porta reclamada (processo encerrado)", () => {
  let host: FakeHost;
  let controller: SyncController;

  beforeEach(() => {
    host = new FakeHost();
    controller = makeController(host);
  });

  test("start com portReclaimed anuncia o PID/nome encerrado e a porta assumida — nunca menciona fallback", async () => {
    host.configuredPort = 1400;
    host.nextStartResult = { ok: true, portReclaimed: { pid: 4242, processName: "Code.exe" } };

    await controller.start();

    expect(host.errors).toHaveLength(0);
    expect(host.infos).toHaveLength(1);
    expect(host.infos[0]).toContain("1400");
    expect(host.infos[0]).toContain("4242");
    expect(host.infos[0]).toContain("Code.exe");
    expect(host.infos[0]).toContain("encerrado com sucesso");
    expect(host.infos[0]).not.toContain("fallback");

    const state = controller.getConnectionState();
    expect(state.running).toBe(true);
    expect(state.port).toBe(1400); // a porta ORIGINALMENTE pedida, nunca uma alternativa
    expect(state.portFallbackFrom).toBeUndefined();
  });

  test("start com portReclaimed sem processName (só PID) ainda mostra o PID claramente", async () => {
    host.nextStartResult = { ok: true, portReclaimed: { pid: 999, processName: null } };

    await controller.start();

    expect(host.infos[0]).toContain("PID 999");
  });

  test("start sem portReclaimed (sucesso normal) continua com a mensagem de sempre, sem menção a processo encerrado", async () => {
    host.configuredPort = 1400;
    host.nextStartResult = { ok: true };

    await controller.start();

    expect(host.infos[0]).toContain("iniciado na porta 1400");
    expect(host.infos[0]).not.toContain("encerrado");
  });

  test("restart com portReclaimed também anuncia a mensagem distinta", async () => {
    host.configuredPort = 1400;
    host.nextStartResult = { ok: true, portReclaimed: { pid: 555, processName: "python.exe" } };

    await controller.restart();

    expect(host.infos.some((m) => m.includes("555") && m.includes("python.exe") && m.includes("encerrado com sucesso"))).toBe(
      true,
    );
  });
});

// Bug real achado pelo code-reviewer (2026-08-02, revisão da feature de
// "posse de porta"): `running` só vira `true` DEPOIS que `host.startService`
// resolve. Durante a janela em que o usuário está olhando o diálogo modal
// "Encerrar processo / Usar porta alternativa" (que pode ficar bloqueado por
// tempo arbitrário), nenhuma guarda barrava um segundo start/restart/setPort
// — criava-se um SEGUNDO serviço, deixando o primeiro órfão se o diálogo
// antigo fosse confirmado depois. Estes testes seguram a resolução de
// `host.startService` manualmente (uma Promise controlada de fora, o mesmo
// papel que `host.confirmKill` bloqueado cumpriria em produção) para simular
// exatamente essa janela e confirmar que uma segunda chamada é rejeitada.
describe("SyncController — reentrância durante start/restart/setPort pendente", () => {
  let host: FakeHost;
  let controller: SyncController;

  function makeStartServiceGate(): {
    install: () => void;
    resolve: (result: StartServiceResult) => void;
    getCalls: () => number;
  } {
    let resolveFn!: (result: StartServiceResult) => void;
    const pending = new Promise<StartServiceResult>((resolve) => {
      resolveFn = resolve;
    });
    let calls = 0;
    return {
      install: () => {
        host.startService = async (port: number) => {
          void port;
          calls += 1;
          return pending;
        };
      },
      resolve: (result: StartServiceResult) => resolveFn(result),
      getCalls: () => calls,
    };
  }

  beforeEach(() => {
    host = new FakeHost();
    controller = makeController(host);
  });

  test("um segundo start() chamado enquanto o primeiro aguarda host.startService é rejeitado — só UM startService é chamado e só UM serviço acaba existindo", async () => {
    const gate = makeStartServiceGate();
    gate.install();

    const firstStart = controller.start();
    // Enquanto o primeiro start ainda está pendente (equivalente ao usuário
    // olhando o diálogo "Encerrar processo / Usar porta alternativa"), um
    // segundo start é disparado — deve ser rejeitado IMEDIATAMENTE, sem
    // esperar o primeiro.
    await controller.start();

    expect(gate.getCalls()).toBe(1); // segunda chamada NÃO criou um segundo serviço
    expect(host.infos.some((m) => m.includes("andamento"))).toBe(true);
    expect(controller.getConnectionState().running).toBe(false); // primeiro ainda pendente

    gate.resolve({ ok: true });
    await firstStart;

    expect(controller.getConnectionState().running).toBe(true);
    // Depois que o primeiro terminou, a flag foi liberada — um novo start
    // funciona normalmente (não fica travado para sempre).
    host.infos.length = 0;
    await controller.stop();
    host.nextStartResult = { ok: true };
    await controller.start();
    expect(controller.getConnectionState().running).toBe(true);
  });

  test("restart() chamado enquanto um start() está pendente é rejeitado — não chama stopService nem um segundo startService", async () => {
    const gate = makeStartServiceGate();
    gate.install();

    const firstStart = controller.start();
    await controller.restart();

    expect(gate.getCalls()).toBe(1);
    expect(host.stopCalls).toBe(0); // restart rejeitado não chegou a chamar stopService
    expect(host.infos.some((m) => m.includes("andamento"))).toBe(true);

    gate.resolve({ ok: true });
    await firstStart;
    expect(controller.getConnectionState().running).toBe(true);
  });

  test("setPort() chamado enquanto um start() está pendente é rejeitado — nem prompta a porta nem persiste config", async () => {
    const gate = makeStartServiceGate();
    gate.install();

    const firstStart = controller.start();
    host.promptResult = "5555";
    await controller.setPort();

    expect(gate.getCalls()).toBe(1);
    expect(host.setPortCalls).toHaveLength(0); // setPort rejeitado não persistiu nada
    expect(host.infos.some((m) => m.includes("andamento"))).toBe(true);

    gate.resolve({ ok: true });
    await firstStart;
    expect(controller.getConnectionState().running).toBe(true);
  });

  test("um segundo restart() chamado enquanto o primeiro restart está pendente é rejeitado — só UM startService é chamado", async () => {
    const gate = makeStartServiceGate();
    gate.install();

    const firstRestart = controller.restart();
    await controller.restart();

    expect(gate.getCalls()).toBe(1);
    expect(host.stopCalls).toBe(1); // só o primeiro restart chegou a chamar stopService

    gate.resolve({ ok: true });
    await firstRestart;
    expect(controller.getConnectionState().running).toBe(true);
  });

  test("autostart (announce:false) pendente também bloqueia um start() explícito subsequente, mas sem popar mensagem para a checagem em si", async () => {
    const gate = makeStartServiceGate();
    gate.install();

    const autostart = controller.start({ announce: false });
    await controller.start(); // comando explícito do usuário, announce:true

    expect(gate.getCalls()).toBe(1);
    // A rejeição do segundo `start()` (announce:true) ainda avisa, mesmo o
    // primeiro tendo sido silencioso.
    expect(host.infos.some((m) => m.includes("andamento"))).toBe(true);

    gate.resolve({ ok: true });
    await autostart;
    expect(controller.getConnectionState().running).toBe(true);
  });
});
