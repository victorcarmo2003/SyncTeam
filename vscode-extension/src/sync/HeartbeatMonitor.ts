// SyncTeam — monitor de heartbeat da conexão WebSocket local (extensão ↔
// plugin Studio). Módulo PURO: não importa `ws` nem `vscode` e não conhece
// socket nenhum — recebe `sendPing`/`onTimeout` como callbacks. Assim a lógica
// de "silêncio prolongado = conexão morta" é testável com timers fake (ver
// test/heartbeatMonitor.test.ts), sem abrir rede de verdade.
//
// Motivação (bug real): quando o processo da extensão morre abruptamente (ex.:
// "Reload Window" do VS Code), o servidor WS cai SEM enviar um frame de close
// ao plugin — e vice-versa. Depender só dos eventos `close`/`error` do socket
// deixa o estado de conexão desatualizado por tempo indefinido. O heartbeat
// resolve isso ativamente: enviamos `ping` periodicamente e, se NENHUMA
// mensagem chegar do outro lado dentro de `timeoutMs`, tratamos a conexão como
// morta mesmo que o socket TCP nunca tenha avisado.

export interface HeartbeatMonitorOptions {
  /** Intervalo (ms) entre pings enviados ao outro lado. */
  intervalMs: number;
  /**
   * Silêncio máximo tolerado (ms) sem NENHUMA mensagem recebida antes de
   * declarar a conexão morta. Deve ser um múltiplo do intervalo (2–3x) para
   * dar margem a alguns pings perdidos sem falso positivo.
   */
  timeoutMs: number;
  /** Envia um ping ao outro lado (o dono fecha sobre o transporte/socket). */
  sendPing: () => void;
  /**
   * Chamado no máximo uma vez por ciclo de vida (o monitor se para sozinho
   * antes de chamar) quando `timeoutMs` estoura — o dono deve fechar o socket.
   */
  onTimeout: () => void;
  /**
   * Relógio injetável (default `Date.now`). Existe só para o teste conseguir
   * controlar o tempo junto com timers fake do vitest.
   */
  now?: () => number;
  /** Log opcional do momento da detecção de queda (nível de aviso). */
  onDeadLog?: (message: string) => void;
}

export class HeartbeatMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt = 0;
  private readonly now: () => number;

  constructor(private readonly options: HeartbeatMonitorOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Começa a bater. Conta o instante do start como "vivo agora" (a conexão
   * acabou de ser estabelecida). Idempotente: chamar de novo sem `stop` antes
   * não cria um segundo timer.
   */
  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.lastActivityAt = this.now();
    this.timer = setInterval(() => this.tick(), this.options.intervalMs);
  }

  /**
   * Registra que ALGO chegou do outro lado (pong, ou qualquer outra mensagem)
   * — reseta o relógio de silêncio. Chamado pelo transporte a cada frame
   * recebido. No-op se o monitor não estiver rodando.
   */
  recordActivity(): void {
    if (this.timer === null) {
      return;
    }
    this.lastActivityAt = this.now();
  }

  /** Para o monitor e cancela o timer. Idempotente. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Está ativo (start chamado, sem stop depois)? */
  isRunning(): boolean {
    return this.timer !== null;
  }

  private tick(): void {
    const silenceMs = this.now() - this.lastActivityAt;
    if (silenceMs > this.options.timeoutMs) {
      // Para ANTES de notificar para não haver reentrância (o onTimeout vai
      // fechar o socket, cujo handler de close pode chamar stop() de novo —
      // idempotente).
      this.stop();
      this.options.onDeadLog?.(
        `nenhuma mensagem do plugin em ${silenceMs}ms (limite ${this.options.timeoutMs}ms) — ` +
          "tratando a conexão como morta e fechando o socket",
      );
      this.options.onTimeout();
      return;
    }
    this.options.sendPing();
  }
}
