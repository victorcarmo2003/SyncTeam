// SyncTeam — rastreamento de presença de colaboradores remotos (M4): cursor,
// seleção e uuid do script ativo de cada sessão remota, para renderizar
// cursores coloridos no editor (RemoteCursorDecorations) e o badge no
// Explorer (FilePresenceDecorations).
//
// Porte adaptado de
// RojoCoop/vscode-extension/src/presence/PresenceTracker.ts: lá a chave de
// "onde o colaborador está" era `filePath` cru; aqui é `uuid` (identidade de
// script do SyncTeam desde o M2), resolvido contra o disco local por quem
// consome este módulo (ver SyncBridge.resolveUuidForDiskPath).
//
// Módulo puro (sem vscode, sem I/O) — mesma disciplina de LeaseTracker.ts —
// testável com vitest sem VS Code real. A camada de ativação
// (extension.ts/SyncTeamService) decide QUANDO chamar
// updatePresence/removePresence/clear/expireStale (a partir dos callbacks de
// SyncTeamService) e QUEM assina onDidChange (as duas camadas de UI).

export interface CollaboratorPresence {
  clientId: string;
  displayName: string;
  /** uuid do script que o colaborador tem ativo, ou null se nenhum (ou arquivo não sincronizado). */
  uuid: string | null;
  cursorLine: number | null;
  cursorColumn: number | null;
  selectionStartLine: number | null;
  selectionStartColumn: number | null;
  /** Date.now() da última atualização — só para a rede de segurança expireStale, ver constante abaixo. */
  lastSeen: number;
}

/**
 * Rede de segurança contra sessão remota que sumiu sem mandar `presenceLeft`
 * (ex.: crash não-gracioso do Studio remoto — mesma lacuna documentada para
 * sessões em docs/DECISIONS.md 2026-07-15: "crash não-gracioso... continua
 * não testado"). O plugin já manda `presenceLeft` explícito no caminho
 * normal (sessão encerrando graciosamente) — isso nunca deveria precisar
 * disparar na prática.
 *
 * Valor escolhido (documentado em .claude/agent-memory/ui-dev.md):
 * staleness de SESSÃO já estabelecida no M3.1 (8s) + margem de 2s, para
 * nunca expirar presença ANTES do próprio mecanismo de sessão detectar a
 * queda e (presumivelmente) parar de mandar presenceChanged — só cobre a
 * lacuna de quando nem um `presenceLeft` explícito chega.
 */
export const PRESENCE_STALE_THRESHOLD_MS = 10_000;

// Porte direto de RojoCoop/vscode-extension/src/presence/PresenceTracker.ts
// (COLLABORATOR_COLORS) — paleta já validada visualmente naquele projeto.
const COLLABORATOR_COLORS = ["#4287f5", "#ea4335", "#34a853", "#fbbc04", "#ab47bc", "#00acc1", "#ff7043", "#8d6e63"];

/** Cor por índice (round-robin pela paleta acima). */
export function getCollaboratorColor(index: number): string {
  return COLLABORATOR_COLORS[index % COLLABORATOR_COLORS.length];
}

export interface PresenceChangeSubscription {
  dispose(): void;
}

export class PresenceTracker {
  private readonly collaborators = new Map<string, CollaboratorPresence>();
  private readonly listeners = new Set<() => void>();

  private fireChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** Assina mudanças (presença atualizada, removida, expirada ou tudo limpo de uma vez). */
  onDidChange(listener: () => void): PresenceChangeSubscription {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** `presenceChanged` chegou do plugin — cria ou substitui a entrada daquele clientId. */
  updatePresence(
    clientId: string,
    displayName: string,
    uuid: string | null,
    cursorLine: number | null,
    cursorColumn: number | null,
    selectionStartLine: number | null,
    selectionStartColumn: number | null,
    now = Date.now(),
  ): void {
    this.collaborators.set(clientId, {
      clientId,
      displayName,
      uuid,
      cursorLine,
      cursorColumn,
      selectionStartLine,
      selectionStartColumn,
      lastSeen: now,
    });
    this.fireChange();
  }

  /** `presenceLeft` chegou do plugin — remove a entrada, se existir. */
  removePresence(clientId: string): void {
    if (this.collaborators.delete(clientId)) {
      this.fireChange();
    }
  }

  /**
   * Nova conexão de plugin ou desconexão: todo estado de presença remota
   * anterior deixa de ser confiável (o canal que o alimentava sumiu/reiniciou).
   */
  clear(): void {
    if (this.collaborators.size === 0) {
      return;
    }
    this.collaborators.clear();
    this.fireChange();
  }

  getAll(): CollaboratorPresence[] {
    return [...this.collaborators.values()];
  }

  getByUuid(uuid: string): CollaboratorPresence[] {
    return this.getAll().filter((c) => c.uuid === uuid);
  }

  /** Índice estável (ordem alfabética de clientId) usado para escolher cor — mesmo critério do RojoCoop. */
  getColorIndex(clientId: string): number {
    const keys = [...this.collaborators.keys()].sort();
    const idx = keys.indexOf(clientId);
    return idx >= 0 ? idx : 0;
  }

  /**
   * Remove entradas sem atualização há `staleThresholdMs` (rede de
   * segurança, não o caminho normal — ver PRESENCE_STALE_THRESHOLD_MS).
   * Método puro (recebe `now` em vez de rodar um timer interno) para ficar
   * determinístico em teste; a camada de ativação chama isso periodicamente
   * via setInterval.
   */
  expireStale(now = Date.now(), staleThresholdMs = PRESENCE_STALE_THRESHOLD_MS): void {
    let changed = false;
    for (const [key, entry] of this.collaborators) {
      if (now - entry.lastSeen >= staleThresholdMs) {
        this.collaborators.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.fireChange();
    }
  }
}
