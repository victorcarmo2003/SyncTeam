// SyncTeam — controlador de ciclo de vida do servidor local (start / stop /
// restart / setPort), extraído de extension.ts para ser testável SEM o runtime
// do VS Code: este módulo não importa `vscode`. extension.ts fornece um
// `SyncControllerHost` que encapsula toda a parte que toca o VS Code (criar/
// parar o serviço, ler/gravar a config `syncteam.port`, pedir a porta ao
// usuário via input box, mostrar mensagens). O controlador só orquestra e
// mantém o estado observável (rodando / porta / conectado) para a status bar
// (ui-dev) consultar e assinar.
//
// Contrato para a status bar (ui-dev): `getConnectionState()` (pull) +
// `onDidChangeConnectionState(listener)` (push). Ver
// .claude/agent-memory/extension-dev.md para a assinatura exata reexportada
// por extension.ts.

import type { Logger } from "./util/logger.js";
import { parsePortInput } from "./util/port.js";

export interface ConnectionState {
  /** O servidor WebSocket local está no ar (bind bem-sucedido e não parado)? */
  running: boolean;
  /**
   * Porta em que o servidor está REALMENTE ouvindo agora (quando `running`).
   * Normalmente igual à porta configurada (`syncteam.port`) — mas pode
   * diferir se a porta configurada estava ocupada e um fallback automático
   * aconteceu no último start (2026-08-02, `.claude/rules/authority.md`; ver
   * `portFallbackFrom` e docs/DECISIONS.md). Enquanto parado, é a última
   * porta configurada lida.
   */
  port: number;
  /** Há um plugin Studio conectado agora? Sempre `false` quando `running` é `false`. */
  connected: boolean;
  /**
   * Presente (com o valor da porta ORIGINALMENTE pedida) só quando `port`
   * acima é resultado de fallback automático de porta ocupada — permite a UI
   * (status bar/ui-dev) destacar essa diferença ao usuário. `undefined` em
   * qualquer outro caso (sem fallback, ou servidor parado).
   */
  portFallbackFrom?: number;
}

/** Estruturalmente compatível com `vscode.Disposable` (`{ dispose(): any }`). */
export interface Disposable {
  dispose(): void;
}

/**
 * Resultado de uma tentativa de iniciar o serviço. `ok` diz se um servidor
 * ficou de fato ouvindo; quando `ok` é `false`, `reason` traz o motivo legível
 * (sem `default.project.json`, sem pontos de montagem, ou mensagem do erro de
 * bind — ex.: `EADDRINUSE`) para o controlador exibir na mensagem de falha.
 * Antes o host devolvia só `boolean` e o motivo se perdia no log; foi
 * enriquecido para o usuário ver *por que* o start falhou (pedido do usuário:
 * o comando não dava nenhum feedback visível de sucesso/falha).
 */
export interface StartServiceResult {
  ok: boolean;
  reason?: string;
  /**
   * Porta em que o servidor ficou REALMENTE ouvindo, quando `ok` é `true`.
   * Presente e diferente da porta pedida só quando um fallback automático de
   * porta ocupada aconteceu dentro de `startService` (ver
   * `SyncServer.getActualPort`/docs/DECISIONS.md, 2026-08-02). Omitido (ou
   * igual à porta pedida) quando não houve fallback.
   */
  actualPort?: number;
  /**
   * Presente só quando `ok` é `true` E um processo foi identificado e
   * encerrado com sucesso para liberar a porta CONFIGURADA antes do bind
   * (2026-08-02, "posse de porta" — docs/DECISIONS.md 3ª rodada /
   * `.claude/rules/authority.md`). Mutuamente exclusivo com `actualPort`
   * diferente da porta pedida na prática: quando há posse de porta bem-
   * sucedida, o servidor está na porta ORIGINALMENTE pedida (não numa
   * alternativa) — é exatamente o CONTRÁRIO do fallback automático, então o
   * controlador mostra uma mensagem distinta confirmando a posse tomada.
   */
  portReclaimed?: { pid: number; processName: string | null };
}

/**
 * Ponte para o mundo do VS Code. extension.ts implementa esta interface; o
 * controlador nunca toca `vscode` diretamente — por isso é testável com fakes.
 */
export interface SyncControllerHost {
  /**
   * Cria e inicia o serviço na `port` dada. Resolve `{ ok: true }` se um
   * servidor ficou de fato ouvindo; `{ ok: false, reason }` se não havia o que
   * iniciar (sem `default.project.json` / sem pontos de montagem) ou o bind
   * falhou. Nunca lança (falhas viram `{ ok: false }` + log do lado do host);
   * ainda assim o controlador trata exceção defensivamente.
   */
  startService(port: number): Promise<StartServiceResult>;
  /** Para o serviço atual e desmonta watchers/estado. Idempotente (no-op se já parado). */
  stopService(): Promise<void>;
  /** Há um plugin Studio conectado agora? (`false` se parado.) */
  isClientConnected(): boolean;
  /** Porta configurada atualmente (workspace config `syncteam.port`). */
  getConfiguredPort(): number;
  /** Persiste `port` em `syncteam.port` (escopo Workspace). */
  setConfiguredPort(port: number): Promise<void>;
  /** Pede a porta nova ao usuário. `undefined` = cancelou. */
  promptForPort(currentPort: number): Promise<string | undefined>;
  /** Mensagem informativa visível ao usuário (ex.: "iniciado", "já está rodando"). */
  info(message: string): void;
  /** Mensagem de erro visível ao usuário (ex.: "falha ao iniciar — EADDRINUSE"). */
  error(message: string): void;
}

export class SyncController {
  private running = false;
  private currentPort: number;
  // Presente (com a porta ORIGINALMENTE pedida) só enquanto o `currentPort`
  // atual for fruto de um fallback automático de porta ocupada no último
  // start bem-sucedido. Ver ConnectionState.portFallbackFrom.
  private portFallbackFrom: number | undefined;
  // Bug real achado pelo code-reviewer (2026-08-02, revisão da feature de
  // "posse de porta"): `running` só vira `true` DEPOIS que `host.startService`
  // resolve — durante a janela em que o usuário está olhando o diálogo modal
  // "Encerrar processo / Usar porta alternativa"
  // (`PortOwnership.ts::attemptPortReclaim` -> `host.confirmKill`, que pode
  // ficar bloqueado por tempo arbitrário), NENHUMA guarda existente barrava um
  // segundo start/restart/setPort (checavam só `this.running`, ainda `false`)
  // — criava-se um SEGUNDO serviço, sobrescrevendo a referência do primeiro no
  // lado do host (extension.ts: variável de módulo `service`), que ficava
  // órfão (sem ninguém para pará-lo) se o diálogo antigo fosse confirmado
  // depois. Exatamente o oposto do objetivo da feature (evitar zumbis de
  // porta). `true` do início de start/restart/setPort até `doStart` terminar
  // (o que inclui esperar `host.startService` resolver ou rejeitar) — ver
  // `rejectIfOperationInProgress`/`restartCore`.
  private startOperationInProgress = false;
  private readonly listeners = new Set<(state: ConnectionState) => void>();

  constructor(
    private readonly host: SyncControllerHost,
    private readonly logger: Logger,
  ) {
    this.currentPort = host.getConfiguredPort();
  }

  /** Estado atual para a status bar consultar sob demanda. */
  getConnectionState(): ConnectionState {
    return {
      running: this.running,
      port: this.currentPort,
      connected: this.running && this.host.isClientConnected(),
      portFallbackFrom: this.portFallbackFrom,
    };
  }

  /**
   * Assina mudanças de estado (start/stop/restart/setPort e conexão/
   * desconexão do plugin). Retorna um Disposable para cancelar. Múltiplos
   * ouvintes são suportados (diferente do padrão `setOnX` de callback único).
   */
  onDidChangeConnectionState(listener: (state: ConnectionState) => void): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /**
   * Reemite o estado atual — chamado por extension.ts quando o plugin conecta
   * ou desconecta (o campo `connected` muda sem `running` mudar).
   */
  notifyConnectionChanged(): void {
    this.emitState();
  }

  /**
   * Inicia o servidor se estiver parado; idempotente (no-op + aviso se já
   * rodando). Sempre dá feedback visível ao usuário (via `host.info`/
   * `host.error`) quando `options.announce` (default `true`) — sucesso mostra a
   * porta, falha mostra o motivo, já-rodando avisa que não fez nada. O
   * autostart da extensão passa `announce: false` para não popar mensagem a
   * cada abertura do workspace (mantém o comportamento silencioso de antes);
   * os comandos do Command Palette usam o default `true`.
   */
  async start(options?: { announce?: boolean }): Promise<void> {
    const announce = options?.announce ?? true;
    if (this.rejectIfOperationInProgress("start", announce)) {
      return;
    }
    if (this.running) {
      this.logger.info("comando start ignorado: servidor já está rodando");
      if (announce) {
        this.host.info(`SyncTeam: o servidor já está rodando na porta ${this.currentPort}.`);
      }
      return;
    }
    this.startOperationInProgress = true;
    try {
      await this.doStart(announce);
    } finally {
      this.startOperationInProgress = false;
    }
  }

  /**
   * Para o servidor SEM reiniciar; fica parado até start/restart/setPort. Não
   * precisa checar `startOperationInProgress`: enquanto uma operação de
   * início está em andamento, `running` permanece `false` até `doStart`
   * terminar — o guard `!this.running` abaixo já garante que `stop()` não
   * interfere no meio de um start/restart pendente (idempotente: cai direto
   * no "já está parado").
   */
  async stop(): Promise<void> {
    if (!this.running) {
      this.logger.info("comando stop ignorado: servidor já está parado");
      this.host.info("SyncTeam: o servidor já está parado.");
      return;
    }
    await this.host.stopService();
    this.running = false;
    // Bug real encontrado pelo code-reviewer (2026-08-02, revisão do fallback
    // de porta): sem isto, currentPort/portFallbackFrom ficavam travados na
    // porta de fallback do último start mesmo depois de parado, contradizendo
    // o doc-comment de ConnectionState.port ("enquanto parado, é a última
    // porta CONFIGURADA lida") e fazendo a status bar mostrar a porta errada
    // mesmo com o servidor parado. `start`/`restart` não tinham esse problema
    // porque recalculam tudo em `doStart` a partir de `getConfiguredPort()`;
    // só `stop()` pulava esse recálculo.
    this.currentPort = this.host.getConfiguredPort();
    this.portFallbackFrom = undefined;
    this.emitState();
    this.host.info("SyncTeam: servidor parado.");
  }

  /**
   * Para e inicia de novo (na porta configurada atual). Sempre deixa o servidor
   * no ar (se possível) e sempre dá feedback visível do resultado do start
   * (sucesso com a porta / falha com o motivo) — reaproveita `doStart`.
   *
   * Guardado por `startOperationInProgress` (ver comentário do campo): um
   * segundo `restart()` disparado enquanto outro start/restart/setPort ainda
   * está em andamento (ex.: aguardando o diálogo de posse de porta) é
   * REJEITADO com aviso, nunca enfileirado nem executado em paralelo — sem
   * isso, `await this.host.stopService()` abaixo poderia derrubar/pisar no
   * serviço que a operação concorrente ainda está criando.
   */
  async restart(): Promise<void> {
    if (this.rejectIfOperationInProgress("restart", true)) {
      return;
    }
    this.startOperationInProgress = true;
    try {
      await this.restartCore();
    } finally {
      this.startOperationInProgress = false;
    }
  }

  /**
   * Pede a porta nova, valida, salva em `syncteam.port` e reinicia. Entrada
   * cancelada ou inválida = não faz absolutamente nada (sem gravar config, sem
   * restart). A validação de fato acontece em `parsePortInput`, a mesma usada
   * pelo `validateInput` do input box no lado do host.
   *
   * Mesma guarda de `restart()` (ver `startOperationInProgress`), pelo mesmo
   * motivo — chama `restartCore()` diretamente (não `this.restart()`, que
   * rejeitaria por já estar com a flag ligada por ESTA própria chamada).
   */
  async setPort(): Promise<void> {
    if (this.rejectIfOperationInProgress("setPort", true)) {
      return;
    }
    this.startOperationInProgress = true;
    try {
      const current = this.host.getConfiguredPort();
      const input = await this.host.promptForPort(current);
      const parsed = parsePortInput(input);
      if (parsed === null) {
        this.logger.info("setPort: entrada cancelada ou inválida — nada alterado");
        return;
      }
      await this.host.setConfiguredPort(parsed);
      this.logger.info(`setPort: porta alterada para ${parsed} — reiniciando o servidor`);
      await this.restartCore();
    } finally {
      this.startOperationInProgress = false;
    }
  }

  /**
   * Núcleo de stop+start reusado por `restart()` e `setPort()`. NÃO checa nem
   * toca `startOperationInProgress` — os dois chamadores já seguram a flag
   * antes de chamar este método; checar de novo aqui rejeitaria a própria
   * chamada em andamento.
   */
  private async restartCore(): Promise<void> {
    await this.host.stopService();
    this.running = false;
    await this.doStart(true);
  }

  /**
   * `true` (e já emitiu o aviso) se outra operação de início/reinício ainda
   * estiver em andamento — `start`/`restart`/`setPort` devem retornar
   * imediatamente sem fazer NADA mais (nem `stopService`, nem `promptForPort`)
   * quando isto retorna `true`. Mesmo padrão de `refreshInProgress` em
   * `extension.ts` (`runRefreshSync`): rejeita com mensagem clara, nunca
   * enfileira nem permite execução em paralelo.
   */
  private rejectIfOperationInProgress(commandLabel: string, announce: boolean): boolean {
    if (!this.startOperationInProgress) {
      return false;
    }
    this.logger.info(
      `comando ${commandLabel} ignorado: outra operação de início/reinício do servidor já está em andamento`,
    );
    if (announce) {
      this.host.info(
        "SyncTeam: já há uma operação de início/reinício do servidor em andamento (ex.: aguardando sua decisão " +
          "sobre uma porta ocupada) — aguarde a conclusão antes de tentar de novo.",
      );
    }
    return true;
  }

  /**
   * Núcleo compartilhado por `start`/`restart`/`setPort`: lê a porta
   * configurada, chama o host, atualiza estado e — quando `announce` — mostra
   * a mensagem visível de sucesso (com a porta, ou com o aviso de fallback se
   * a porta configurada estava ocupada) ou de falha (com o motivo). Trata
   * exceção do host defensivamente (o contrato diz que ele nunca lança, mas
   * se lançar a cadeia não pode terminar em silêncio): vira uma falha
   * anunciada, nunca uma Promise rejeitada borbulhando para o registro do
   * comando.
   */
  private async doStart(announce: boolean): Promise<void> {
    const requestedPort = this.host.getConfiguredPort();
    let ok: boolean;
    let reason: string | undefined;
    let actualPort: number | undefined;
    let portReclaimed: { pid: number; processName: string | null } | undefined;
    try {
      const result = await this.host.startService(requestedPort);
      ok = result.ok;
      reason = result.reason;
      actualPort = result.actualPort;
      portReclaimed = result.portReclaimed;
    } catch (error) {
      ok = false;
      reason = (error as Error).message;
    }
    this.running = ok;
    // Fallback automático de porta ocupada (2026-08-02,
    // .claude/rules/authority.md): quando o host reporta uma porta REAL
    // diferente da pedida, é essa a porta em que o servidor está de fato —
    // currentPort (consultado pela status bar via getConnectionState) passa a
    // refletir a porta real, nunca a pedida-mas-não-usada. Em qualquer outro
    // caso (sucesso sem fallback, ou falha) currentPort é a pedida e
    // portFallbackFrom é limpo.
    if (ok && actualPort !== undefined && actualPort !== requestedPort) {
      this.currentPort = actualPort;
      this.portFallbackFrom = requestedPort;
    } else {
      this.currentPort = requestedPort;
      this.portFallbackFrom = undefined;
    }
    this.emitState();
    if (!announce) {
      return;
    }
    if (ok) {
      if (this.portFallbackFrom !== undefined) {
        this.host.info(
          `SyncTeam: a porta configurada ${this.portFallbackFrom} estava ocupada — servidor iniciado na porta ` +
            `${this.currentPort} (fallback automático). Aponte o plugin do Studio para a porta ${this.currentPort}, ` +
            `ou rode "SyncTeam: Trocar porta" / libere a porta ${this.portFallbackFrom} e reinicie para voltar a ela.`,
        );
      } else if (portReclaimed) {
        // "Posse de porta" (2026-08-02, docs/DECISIONS.md 3ª rodada): a porta
        // estava ocupada, mas o usuário optou por encerrar o processo
        // ocupante em vez de cair no fallback — o servidor ficou na porta
        // ORIGINALMENTE pedida (currentPort === requestedPort aqui, nunca uma
        // alternativa), então a mensagem é distinta da de fallback acima.
        const label = portReclaimed.processName
          ? `${portReclaimed.processName} (PID ${portReclaimed.pid})`
          : `PID ${portReclaimed.pid}`;
        this.host.info(
          `SyncTeam: a porta ${this.currentPort} estava ocupada por ${label} — encerrado com sucesso, o servidor ` +
            `assumiu a porta ${this.currentPort}.`,
        );
      } else {
        this.host.info(`SyncTeam: servidor iniciado na porta ${this.currentPort}.`);
      }
    } else {
      this.host.error(`SyncTeam: falha ao iniciar — ${reason ?? "motivo desconhecido"}.`);
    }
  }

  private emitState(): void {
    const state = this.getConnectionState();
    for (const listener of [...this.listeners]) {
      listener(state);
    }
  }
}
