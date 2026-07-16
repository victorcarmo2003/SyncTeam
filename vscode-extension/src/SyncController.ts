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
  /** Porta em que o servidor está (ou tentou) rodar — sempre a porta configurada atual. */
  port: number;
  /** Há um plugin Studio conectado agora? Sempre `false` quando `running` é `false`. */
  connected: boolean;
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
    if (this.running) {
      this.logger.info("comando start ignorado: servidor já está rodando");
      if (announce) {
        this.host.info(`SyncTeam: o servidor já está rodando na porta ${this.currentPort}.`);
      }
      return;
    }
    await this.doStart(announce);
  }

  /** Para o servidor SEM reiniciar; fica parado até start/restart/setPort. */
  async stop(): Promise<void> {
    if (!this.running) {
      this.logger.info("comando stop ignorado: servidor já está parado");
      this.host.info("SyncTeam: o servidor já está parado.");
      return;
    }
    await this.host.stopService();
    this.running = false;
    this.emitState();
    this.host.info("SyncTeam: servidor parado.");
  }

  /**
   * Para e inicia de novo (na porta configurada atual). Sempre deixa o servidor
   * no ar (se possível) e sempre dá feedback visível do resultado do start
   * (sucesso com a porta / falha com o motivo) — reaproveita `doStart`.
   */
  async restart(): Promise<void> {
    await this.host.stopService();
    this.running = false;
    await this.doStart(true);
  }

  /**
   * Pede a porta nova, valida, salva em `syncteam.port` e reinicia. Entrada
   * cancelada ou inválida = não faz absolutamente nada (sem gravar config, sem
   * restart). A validação de fato acontece em `parsePortInput`, a mesma usada
   * pelo `validateInput` do input box no lado do host.
   */
  async setPort(): Promise<void> {
    const current = this.host.getConfiguredPort();
    const input = await this.host.promptForPort(current);
    const parsed = parsePortInput(input);
    if (parsed === null) {
      this.logger.info("setPort: entrada cancelada ou inválida — nada alterado");
      return;
    }
    await this.host.setConfiguredPort(parsed);
    this.logger.info(`setPort: porta alterada para ${parsed} — reiniciando o servidor`);
    await this.restart();
  }

  /**
   * Núcleo compartilhado por `start`/`restart`/`setPort`: lê a porta
   * configurada, chama o host, atualiza estado e — quando `announce` — mostra
   * a mensagem visível de sucesso (com a porta) ou de falha (com o motivo).
   * Trata exceção do host defensivamente (o contrato diz que ele nunca lança,
   * mas se lançar a cadeia não pode terminar em silêncio): vira uma falha
   * anunciada, nunca uma Promise rejeitada borbulhando para o registro do
   * comando.
   */
  private async doStart(announce: boolean): Promise<void> {
    this.currentPort = this.host.getConfiguredPort();
    let ok: boolean;
    let reason: string | undefined;
    try {
      const result = await this.host.startService(this.currentPort);
      ok = result.ok;
      reason = result.reason;
    } catch (error) {
      ok = false;
      reason = (error as Error).message;
    }
    this.running = ok;
    this.emitState();
    if (!announce) {
      return;
    }
    if (ok) {
      this.host.info(`SyncTeam: servidor iniciado na porta ${this.currentPort}.`);
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
