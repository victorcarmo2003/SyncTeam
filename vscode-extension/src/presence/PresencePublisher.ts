// SyncTeam — publica a presença (cursor/seleção/arquivo ativo) do dev LOCAL
// para o plugin (M4). Porte adaptado de
// RojoCoop/vscode-extension/src/presence/PresencePublisher.ts: lá o
// transporte era um `CollabSocket` genérico ponto-a-ponto; aqui é a mesma
// conexão SyncServer/SyncTeamService já usada para leases (M3) — ver
// `PresenceTransport` abaixo, injetado por quem instancia isso
// (SyncTeamService.sendPresenceUpdate).
//
// Módulo puro (sem vscode) — mesma disciplina de LeaseTracker.ts. A camada
// de ativação (extension.ts) é quem escuta
// `vscode.window.onDidChangeActiveTextEditor`/`onDidChangeTextEditorSelection`,
// debounça (~150ms, mesma constante já usada pro FileSystemWatcher — ver
// WATCH_DEBOUNCE_MS em extension.ts), resolve o uuid do arquivo ativo via
// `SyncTeamService.resolveUuidForDiskPath` e chama `publish()` com o payload
// já montado. Isso mantém este módulo testável com vitest sem depender do
// runtime do VS Code (que não está disponível fora do Extension Host).

export interface PresenceUpdatePayload {
  uuid: string | null;
  cursorLine: number | null;
  cursorColumn: number | null;
  selectionStartLine: number | null;
  selectionStartColumn: number | null;
}

/**
 * Vocabulário mínimo que o PresencePublisher precisa do canal com o plugin —
 * mesmo espírito do `Transport` de SyncBridge.ts, mas para a mensagem
 * espontânea sem ack `presenceUpdate` (ver SyncServer.sendSpontaneous).
 */
export interface PresenceTransport {
  sendPresenceUpdate(payload: PresenceUpdatePayload): void;
}

const EMPTY_PAYLOAD: PresenceUpdatePayload = {
  uuid: null,
  cursorLine: null,
  cursorColumn: null,
  selectionStartLine: null,
  selectionStartColumn: null,
};

export class PresencePublisher {
  private lastSentKey: string | null = null;

  constructor(private readonly transport: PresenceTransport) {}

  /**
   * Publica o estado atual, com dedupe: não reenvia se for idêntico ao
   * último payload já enviado. A camada de ativação já debounça ~150ms antes
   * de chamar isso (ver extension.ts) — o dedupe aqui evita reenvio
   * redundante quando o debounce dispara sem mudança real de conteúdo (ex.:
   * evento de seleção disparado por foco, sem o cursor de fato se mover).
   */
  publish(payload: PresenceUpdatePayload): void {
    const key = JSON.stringify(payload);
    if (key === this.lastSentKey) {
      return;
    }
    this.lastSentKey = key;
    this.transport.sendPresenceUpdate(payload);
  }

  /** Limpa minha presença (nenhum arquivo sincronizado ativo, ou nenhum editor ativo). */
  publishClear(): void {
    this.publish(EMPTY_PAYLOAD);
  }

  /**
   * Força o próximo `publish` a ser enviado mesmo que idêntico ao último —
   * usado quando o canal reconecta (o plugin do outro lado perdeu todo
   * estado anterior, então mesmo um payload "igual" precisa ser reenviado).
   */
  resetDedupe(): void {
    this.lastSentKey = null;
  }
}
