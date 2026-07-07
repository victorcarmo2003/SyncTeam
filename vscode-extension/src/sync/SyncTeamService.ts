// SyncTeam — junta SyncServer (transporte) e SyncBridge (lógica) num único
// serviço. Não sabe se está rodando dentro do VS Code ou de um harness Node:
// recebe DiskIO e MountPoint[] já resolvidos por quem o instancia.

import { SyncBridge, type Transport, type OnWriteRejectedCallback } from "./SyncBridge.js";
import { SyncServer } from "./SyncServer.js";
import { LeaseTracker } from "./LeaseTracker.js";
import type { DiskIO } from "./DiskIO.js";
import type { MountPoint } from "../mapping/projectMapping.js";
import type { Logger } from "../util/logger.js";
import type { RawMessage } from "../protocol.js";

/**
 * Callback chamado quando uma lease muda. Permite que a camada de ativação
 * (extension.ts) reaja com UI visível (status bar, mensagens, etc.).
 */
export type OnLeaseChangedCallback = (message: {
  uuid: string;
  ownerClientId: string | null;
  ownerDisplayName: string | null;
}) => void;

export class SyncTeamService {
  private readonly bridge: SyncBridge;
  private readonly transport: Transport;
  private leaseTracker: LeaseTracker | null = null;
  private onLeaseChanged: OnLeaseChangedCallback | null = null;

  constructor(
    private readonly server: SyncServer,
    mountPoints: MountPoint[],
    diskIO: DiskIO,
    private readonly logger: Logger,
  ) {
    this.bridge = new SyncBridge(mountPoints, diskIO, logger);
    this.transport = { request: (message) => this.server.request(message) };

    this.server.setHandlers({
      onClientConnected: (hello: RawMessage) => {
        // M3.1: capturar clientId do hello para rastreamento de identidade.
        const clientId = typeof hello.clientId === "string" || hello.clientId === null ? hello.clientId : null;
        this.leaseTracker = new LeaseTracker(clientId);
        this.logger.info(`meu clientId: ${clientId ?? "(nenhum)"}`);

        this.bridge.runInitialSync(this.transport).catch((error: Error) => {
          this.logger.error(`sincronização inicial falhou: ${error.message}`);
        });
      },
      onClientDisconnected: () => {
        // M1: nada a fazer — reconexão simplesmente dispara runInitialSync de novo.
      },
      onSpontaneous: (message: RawMessage) => this.routeSpontaneous(message),
    });
  }

  /**
   * Define um callback para ser chamado quando leaseChanged chegar.
   * Usado pela camada de ativação (extension.ts) para reagir com UI.
   */
  setOnLeaseChanged(callback: OnLeaseChangedCallback): void {
    this.onLeaseChanged = callback;
  }

  /**
   * Define um callback para ser chamado quando uma escrita for rejeitada.
   * Usado pela camada de ativação (extension.ts) para mostrar uma mensagem de erro.
   */
  setOnWriteRejected(callback: OnWriteRejectedCallback): void {
    this.bridge.setOnWriteRejected(callback);
  }

  /** Retorna o rastreador de leases (pode ser null se hello ainda não foi recebido). */
  getLeaseTracker(): LeaseTracker | null {
    return this.leaseTracker;
  }

  private routeSpontaneous(message: RawMessage): void {
    switch (message.kind) {
      case "sourceChanged":
        this.bridge.handleSourceChanged(message).catch((error: Error) => this.logger.error(`sourceChanged: ${error.message}`));
        break;
      case "scriptAdded":
        this.bridge
          .handleScriptAdded(message, this.transport)
          .catch((error: Error) => this.logger.error(`scriptAdded: ${error.message}`));
        break;
      case "scriptMoved":
        this.bridge.handleScriptMoved(message).catch((error: Error) => this.logger.error(`scriptMoved: ${error.message}`));
        break;
      case "scriptRemoved":
        this.bridge.handleScriptRemoved(message).catch((error: Error) => this.logger.error(`scriptRemoved: ${error.message}`));
        break;
      case "leaseChanged":
        this.handleLeaseChanged(message);
        break;
      default:
        this.logger.info(`mensagem espontânea de kind desconhecido ignorada: ${message.kind}`);
    }
  }

  private handleLeaseChanged(message: RawMessage): void {
    const uuid = message.uuid;
    // O lado Luau usa HttpService:JSONEncode sobre uma tabela — atribuir nil
    // a um campo remove a chave da tabela, então "lease liberada" chega como
    // campo AUSENTE (undefined), nunca como `null` de verdade. Normaliza os
    // dois casos (ausente ou null) para null antes de validar (bug real
    // encontrado em code review, 2026-07-04 — ver docs/DECISIONS.md).
    const ownerClientId = message.ownerClientId ?? null;
    const ownerDisplayName = message.ownerDisplayName ?? null;

    if (typeof uuid !== "string" || uuid.length === 0) {
      this.logger.error(`leaseChanged sem uuid válido, ignorado`);
      return;
    }

    // ownerClientId pode ser null (lease liberada) ou string
    if (typeof ownerClientId !== "string" && ownerClientId !== null) {
      this.logger.error(`leaseChanged com ownerClientId inválido, ignorado`);
      return;
    }

    // ownerDisplayName pode ser null (não fornecido) ou string
    if (typeof ownerDisplayName !== "string" && ownerDisplayName !== null) {
      this.logger.error(`leaseChanged com ownerDisplayName inválido, ignorado`);
      return;
    }

    // Atualizar rastreador se disponível.
    if (this.leaseTracker) {
      this.leaseTracker.updateLease(uuid, ownerClientId, ownerDisplayName);
    }

    // Notificar a camada de ativação (extension.ts) para reagir com UI.
    if (this.onLeaseChanged) {
      this.onLeaseChanged({ uuid, ownerClientId, ownerDisplayName });
    }
  }

  start(): Promise<void> {
    return this.server.start();
  }

  stop(): Promise<void> {
    return this.server.stop();
  }

  /** Chamado pelo watcher de arquivos (fs.watch ou vscode.FileSystemWatcher) da camada de ativação. */
  notifyLocalFileChange(relDiskPath: string): void {
    this.bridge.handleLocalFileChange(relDiskPath, this.transport).catch((error: Error) => {
      this.logger.error(`disco → Studio: erro processando mudança local '${relDiskPath}': ${error.message}`);
    });
  }
}
