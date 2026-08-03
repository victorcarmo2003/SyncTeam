// SyncTeam — junta SyncServer (transporte) e SyncBridge (lógica) num único
// serviço. Não sabe se está rodando dentro do VS Code ou de um harness Node:
// recebe DiskIO e MountPoint[] já resolvidos por quem o instancia.

import { SyncBridge, type Transport, type OnWriteRejectedCallback, type OnSyncConflictCallback } from "./SyncBridge.js";
import { SyncServer } from "./SyncServer.js";
import { LeaseTracker } from "./LeaseTracker.js";
import type { DiskIO } from "./DiskIO.js";
import { computeWatchedRoots, type MountPoint } from "../mapping/projectMapping.js";
import type { Logger } from "../util/logger.js";
import type { RawMessage } from "../protocol.js";
import type { PresenceTransport, PresenceUpdatePayload } from "../presence/PresencePublisher.js";

/**
 * Callback chamado quando uma lease muda. Permite que a camada de ativação
 * (extension.ts) reaja com UI visível (status bar, mensagens, etc.).
 */
export type OnLeaseChangedCallback = (message: {
  uuid: string;
  ownerClientId: string | null;
  ownerDisplayName: string | null;
}) => void;

/**
 * Callback chamado quando `presenceChanged` (M4) chega de uma sessão remota.
 * A camada de ativação (extension.ts) repassa isso para o `PresenceTracker`
 * que ela mesma possui — SyncTeamService não guarda estado de presença,
 * só valida/normaliza e encaminha (mesmo espírito de `OnLeaseChangedCallback`).
 */
export type OnPresenceChangedCallback = (presence: {
  clientId: string;
  displayName: string;
  uuid: string | null;
  cursorLine: number | null;
  cursorColumn: number | null;
  selectionStartLine: number | null;
  selectionStartColumn: number | null;
}) => void;

/** Callback chamado quando `presenceLeft` (M4) chega — sessão remota saiu/expirou. */
export type OnPresenceLeftCallback = (message: { clientId: string }) => void;

/**
 * Callback chamado quando um plugin é rejeitado por erro de protocolo
 * (protocolVersion incompatível). A camada de ativação (extension.ts) usa isso
 * para mostrar um aviso visível — antes disso o erro só ia para o log.
 */
export type OnProtocolErrorCallback = (message: string) => void;

/**
 * Callback que mostra a confirmação modal ANTES de um "ReSync" destrutivo
 * (2026-08-02, ver docs/DECISIONS.md "5ª rodada") — apagar e recriar todo
 * Source sincronizado é ação com risco, então quem decide de fato é o lado
 * que vai perder o arquivo local, nunca o clique isolado no Studio. Mesmo
 * padrão de `PortReclaimHost.confirmKill` (`PortOwnership.ts`, 2026-08-02,
 * 3ª rodada): mantém este módulo livre de `vscode`/testável com um fake — a
 * camada de ativação (extension.ts) é quem liga isto a
 * `vscode.window.showWarningMessage(..., {modal:true}, ...)`. Resolve `true`
 * se o usuário confirmou, `false` se cancelou ou fechou sem escolher.
 */
export type ConfirmResyncCallback = (message: string) => Promise<boolean>;

/**
 * Callback chamado quando todo estado de presença remota deixa de ser
 * confiável (nova conexão de plugin OU desconexão) — a camada de ativação
 * deve limpar seu `PresenceTracker` inteiro nesse momento.
 */
export type OnPresenceResetCallback = () => void;

// multiSync: janela de dedupe (ms) para mensagens espontâneas duplicadas
// vindas de 2+ Studios reportando a MESMA mudança (esperado — são a mesma
// place via Team Create). "Simples e barato" por pedido explícito da tarefa:
// só compara a assinatura da ÚLTIMA mensagem processada, não um histórico.
// 800ms cobre o caso real (2 plugins mandando quase ao mesmo tempo) sem
// arriscar descartar uma segunda edição legítima e rápida no mesmo uuid (que
// na prática quase sempre tem conteúdo diferente).
const SPONTANEOUS_DEDUPE_WINDOW_MS = 800;

export class SyncTeamService {
  private readonly bridge: SyncBridge;
  private readonly transport: Transport;
  private readonly presenceTransport: PresenceTransport;
  private leaseTracker: LeaseTracker | null = null;
  private onLeaseChanged: OnLeaseChangedCallback | null = null;
  private onPresenceChanged: OnPresenceChangedCallback | null = null;
  private onPresenceLeft: OnPresenceLeftCallback | null = null;
  private onPresenceReset: OnPresenceResetCallback | null = null;
  private onConnectionChanged: (() => void) | null = null;
  private onProtocolError: OnProtocolErrorCallback | null = null;
  private onPluginConnected: (() => void) | null = null;
  private onPluginDisconnected: (() => void) | null = null;
  private onConfirmResync: ConfirmResyncCallback | null = null;
  // multiSync: dedupe de espontânea duplicada (ver routeSpontaneous). Fica
  // null/0 até a primeira mensagem processada; só ativo quando `multiSync`.
  private lastSpontaneousSignature: string | null = null;
  private lastSpontaneousAt = 0;

  // Fila FIFO que serializa toda mutação de estado compartilhado do
  // SyncBridge + I/O de disco (bug real relatado 2026-07-27, ver
  // .claude/agent-memory/extension-dev.md e docs/DECISIONS.md mesma data):
  // ANTES desta fila, `routeSpontaneous` despachava `sourceChanged`/
  // `scriptAdded`/`scriptMoved`/`scriptRemoved` fire-and-forget a partir do
  // handler SÍNCRONO de mensagem do `SyncServer` (que processa cada frame do
  // WebSocket assim que chega, sem esperar o handler assíncrono anterior
  // terminar). Uma rajada de mensagens quase simultâneas do Studio (ex.:
  // reparentar ~30 scripts/pastas de uma vez no Explorer, gerando ~30
  // `scriptMoved` em menos de 1.5s) disparava várias chamadas CONCORRENTES a
  // `SyncBridge.handleScriptMoved`/etc., todas lendo/escrevendo os MESMOS
  // mapas mutáveis (`scripts`/`diskPathByUuid`/`uuidByDiskPath`/
  // `contentCache`) e fazendo I/O de disco assíncrono intercalado —
  // corrompendo o layout final (arquivo duplicado, promoção pasta->arquivo
  // nunca concluída porque nenhuma chamada individual via um snapshot
  // consistente de `this.scripts`).
  //
  // `enqueueMutation` encadeia cada tarefa em `queueTail`, garantindo (1)
  // ORDEM FIFO de chegada e (2) que cada handler complete por inteiro
  // (inclusive todos os `await` internos) antes do próximo começar.
  // `queueTail` em si NUNCA rejeita — o `.then(noop, noop)` engole
  // resultado/erro da tarefa anterior só para efeito de "posso seguir para a
  // próxima" — assim um handler que falha não trava a fila inteira; quem
  // enfileira ainda recebe a Promise ORIGINAL (com o erro, se houver) para
  // logar exatamente como já fazia antes (`.catch(...)`).
  //
  // Deliberadamente inclui `runInitialSync`/`refreshSync` (também mutam os
  // mesmos mapas + tocam disco) e `handleLocalFileChange` (via
  // `notifyLocalFileChange`, chamado pelo watcher de arquivos — mexe nos
  // MESMOS mapas compartilhados, então uma edição local concorrente com uma
  // rajada de mensagens do Studio tem o MESMO tipo de corrida). NÃO inclui
  // `leaseChanged`/`presenceChanged`/`presenceLeft`/`log` — esses nunca tocam
  // `this.bridge`/disco (só `leaseTracker`/callbacks de UI/logger), então
  // enfileirá-los só adicionaria latência artificial a mensagens de alta
  // frequência (presença/cursor) sem nenhum ganho de correção.
  private queueTail: Promise<void> = Promise.resolve();

  // Genérico desde 2026-08-02 (ReSync): `resyncFromScratch` precisa devolver
  // `deletedCount` (número) para quem chamou, diferente das demais mutações
  // enfileiradas até então (todas `Promise<void>`, valor descartado). `T`
  // default continua compatível com todo call site pré-existente sem
  // nenhuma mudança neles — `void` é só mais um `T` possível.
  private enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queueTail.then(task);
    this.queueTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  constructor(
    private readonly server: SyncServer,
    private readonly mountPoints: MountPoint[],
    diskIO: DiskIO,
    private readonly logger: Logger,
    private readonly multiSync: boolean = false,
  ) {
    this.bridge = new SyncBridge(mountPoints, diskIO, logger);
    this.transport = { request: (message) => this.server.request(message) };
    this.presenceTransport = { sendPresenceUpdate: (payload) => this.sendPresenceUpdate(payload) };

    this.server.setHandlers({
      onClientConnected: (hello: RawMessage) => {
        // M3.1: capturar clientId do hello para rastreamento de identidade.
        const clientId = typeof hello.clientId === "string" || hello.clientId === null ? hello.clientId : null;
        this.leaseTracker = new LeaseTracker(clientId);
        this.logger.info(`meu clientId: ${clientId ?? "(nenhum)"}`);

        // M4: canal novo (ou reconectado) — todo estado de presença remota
        // observado antes desta conexão não é mais confiável.
        this.onPresenceReset?.();

        // watchedRoots (2026-07-29, ver protocol.ts): manda a lista de
        // serviços de topo referenciados pelos mount points do
        // default.project.json ATUAL, ANTES do listScripts da sincronização
        // inicial — o plugin precisa saber quais containers escanear antes de
        // reportar scriptList. Espontânea (sem requestId/ack), mesmo
        // mecanismo de sendPresenceUpdate.
        const roots = computeWatchedRoots(this.mountPoints);
        this.logger.info(`watchedRoots: ${roots.join(", ") || "(nenhum)"}`);
        this.server.sendSpontaneous({ kind: "watchedRoots", roots });

        this.enqueueMutation(() => this.bridge.runInitialSync(this.transport)).catch((error: Error) => {
          this.logger.error(`sincronização inicial falhou: ${error.message}`);
        });

        // Estado de conexão mudou (plugin conectou) — a status bar (ui-dev)
        // observa isso via SyncController.onDidChangeConnectionState.
        this.onConnectionChanged?.();

        // Notificação visível ao usuário (plugin conectou). Só dispara em
        // conexão real de socket, nunca em start/stop deliberado do servidor.
        this.onPluginConnected?.();
      },
      onClientDisconnected: () => {
        // M1: nada a fazer para a sincronização em si — reconexão
        // simplesmente dispara runInitialSync de novo.
        // M4: o canal que alimentava presença remota sumiu.
        this.onPresenceReset?.();

        // Estado de conexão mudou (plugin desconectou).
        this.onConnectionChanged?.();

        // Notificação visível. Este handler NÃO dispara numa parada deliberada
        // do servidor (stop/restart/setPort): SyncServer.stop() zera
        // `this.client` antes do evento `close` chegar, então o guard
        // `this.client === socket` do handler de close pula o callback. Logo,
        // isto só é "desconexão-surpresa": queda real ou timeout de heartbeat.
        this.onPluginDisconnected?.();
      },
      onSpontaneous: (message: RawMessage) => this.routeSpontaneous(message),
      onProtocolError: (message: string) => {
        this.onProtocolError?.(message);
      },
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

  /**
   * Define um callback para ser chamado quando a reconciliação sob demanda
   * ("Refresh Sync") detectar um conflito genuíno (disco e Studio divergiram
   * ambos do último sincronizado). Usado por extension.ts para avisar o usuário.
   */
  setOnSyncConflict(callback: OnSyncConflictCallback): void {
    this.bridge.setOnSyncConflict(callback);
  }

  /**
   * "Refresh Sync": dispara a reconciliação bidirecional completa sob demanda
   * (merge de 3 vias) para todos os arquivos mapeados. Ver
   * `SyncBridge.refreshSync`. Quem chama (extension.ts) deve garantir que há um
   * plugin conectado (`isClientConnected`) antes — senão o `listScripts`
   * interno vai falhar com "nenhum plugin conectado".
   */
  refreshSync(): Promise<void> {
    return this.enqueueMutation(() => this.bridge.refreshSync(this.transport));
  }

  /** Há um plugin Studio conectado agora? (Guarda para o comando Refresh Sync.) */
  isClientConnected(): boolean {
    return this.server.isClientConnected();
  }

  /**
   * Quantos plugins estão conectados agora (1 no modo default; pode ser >1
   * com `syncteam.multiSync`). Passthrough para `SyncServer.getConnectedCount`
   * — exposto para quem quiser mostrar isso na UI no futuro (ui-dev); esta
   * fatia não constrói UI nova.
   */
  getConnectedCount(): number {
    return this.server.getConnectedCount();
  }

  /**
   * Porta em que o servidor está REALMENTE ouvindo agora, ou `null` se
   * parado. Passthrough para `SyncServer.getActualPort` — difere da porta
   * configurada (`syncteam.port`) quando um fallback automático de porta
   * ocupada aconteceu (2026-08-02, `.claude/rules/authority.md`; ver
   * docs/DECISIONS.md).
   */
  getActualPort(): number | null {
    return this.server.getActualPort();
  }

  /**
   * Passthrough para `SyncServer.getLastReclaimed()` — info do processo
   * identificado e encerrado (via "posse de porta", 2026-08-02,
   * docs/DECISIONS.md 3ª rodada) para liberar a porta configurada no último
   * `start()`, ou `null` se não houve tomada de posse.
   */
  getLastReclaimed(): { pid: number; processName: string | null } | null {
    return this.server.getLastReclaimed();
  }

  /** Retorna o rastreador de leases (pode ser null se hello ainda não foi recebido). */
  getLeaseTracker(): LeaseTracker | null {
    return this.leaseTracker;
  }

  /** M4: callback chamado quando `presenceChanged` chega de uma sessão remota. */
  setOnPresenceChanged(callback: OnPresenceChangedCallback): void {
    this.onPresenceChanged = callback;
  }

  /** M4: callback chamado quando `presenceLeft` chega (sessão remota saiu/expirou). */
  setOnPresenceLeft(callback: OnPresenceLeftCallback): void {
    this.onPresenceLeft = callback;
  }

  /** M4: callback chamado quando todo estado de presença remota deve ser descartado (conexão nova ou desconexão). */
  setOnPresenceReset(callback: OnPresenceResetCallback): void {
    this.onPresenceReset = callback;
  }

  /**
   * Callback disparado quando um plugin conecta OU desconecta — ou seja,
   * quando `isClientConnected()` pode ter mudado de valor. extension.ts usa
   * isso para reemitir o estado do `SyncController` (campo `connected`) para a
   * status bar. Não carrega o valor novo: quem reage deve consultar
   * `isClientConnected()` no momento.
   */
  setOnConnectionChanged(callback: () => void): void {
    this.onConnectionChanged = callback;
  }

  /**
   * Define um callback para erro de protocolo (protocolVersion incompatível) —
   * a camada de ativação (extension.ts) mostra um aviso visível. Segue o mesmo
   * padrão de `setOnWriteRejected`/`setOnSyncConflict`.
   */
  setOnProtocolError(callback: OnProtocolErrorCallback): void {
    this.onProtocolError = callback;
  }

  /**
   * Callback disparado quando um plugin conecta de fato (hello aceito). Só em
   * conexão real de socket — não em start/restart do servidor. extension.ts usa
   * para uma notificação visível de "conectado".
   */
  setOnPluginConnected(callback: () => void): void {
    this.onPluginConnected = callback;
  }

  /**
   * Callback disparado quando o plugin desconecta de forma NÃO deliberada
   * (queda real de socket ou timeout de heartbeat) — nunca numa parada
   * intencional do servidor (ver comentário no handler onClientDisconnected).
   * extension.ts usa para uma notificação visível de "desconectou".
   */
  setOnPluginDisconnected(callback: () => void): void {
    this.onPluginDisconnected = callback;
  }

  /**
   * Define o callback que mostra a confirmação modal antes de um "ReSync"
   * destrutivo. Ver `ConfirmResyncCallback` para o contrato completo. Sem
   * callback registrado, `resyncRequest` é recusado por segurança (nunca
   * apaga nada sem uma forma de confirmar com o usuário).
   */
  setOnConfirmResync(callback: ConfirmResyncCallback): void {
    this.onConfirmResync = callback;
  }

  /**
   * Resolve o uuid do script sincronizado materializado em `diskPath`
   * (relativo à raiz do workspace), ou `null` se não for um script
   * sincronizado conhecido. Usado pela camada de presença (M4) tanto para
   * publicar minha própria presença (PresencePublisher) quanto para saber
   * quais colaboradores mostrar no editor/Explorer ativo.
   */
  resolveUuidForDiskPath(diskPath: string): string | null {
    return this.bridge.resolveUuidForDiskPath(diskPath);
  }

  /** M4: direção inversa — diskPath atualmente materializado para `uuid`, ou null. Ver SyncBridge.resolveDiskPathForUuid. */
  resolveDiskPathForUuid(uuid: string): string | null {
    return this.bridge.resolveDiskPathForUuid(uuid);
  }

  /** M4: envia `presenceUpdate` (minha presença local) ao plugin, sem esperar resposta. */
  sendPresenceUpdate(payload: PresenceUpdatePayload): void {
    this.server.sendSpontaneous({ kind: "presenceUpdate", ...payload });
  }

  /** M4: transporte mínimo para injetar num `PresencePublisher` (ver presence/PresencePublisher.ts). */
  getPresenceTransport(): PresenceTransport {
    return this.presenceTransport;
  }

  /**
   * multiSync: assinatura barata (kind + campos relevantes) para detectar
   * duas mensagens espontâneas "iguais" chegando de 2 Studios diferentes
   * quase ao mesmo tempo (mesma place via Team Create replicando pros dois).
   * Cai num `JSON.stringify` genérico para qualquer `kind` não listado
   * explicitamente — cobre casos futuros sem precisar lembrar de atualizar
   * aqui toda vez que um `kind` novo for adicionado ao protocolo.
   */
  private computeSpontaneousSignature(message: RawMessage): string {
    switch (message.kind) {
      case "sourceChanged":
        return `sourceChanged:${String(message.uuid)}:${String(message.source)}`;
      case "scriptAdded":
        return `scriptAdded:${String(message.uuid)}:${String(message.path)}:${String(message.className)}`;
      case "scriptMoved":
        return `scriptMoved:${String(message.uuid)}:${String(message.oldPath)}:${String(message.newPath)}:${String(message.className)}`;
      case "scriptRemoved":
        return `scriptRemoved:${String(message.uuid)}`;
      case "leaseChanged":
        return `leaseChanged:${String(message.uuid)}:${String(message.ownerClientId)}`;
      case "presenceChanged":
        return (
          `presenceChanged:${String(message.clientId)}:${String(message.uuid)}:` +
          `${String(message.cursorLine)}:${String(message.cursorColumn)}:` +
          `${String(message.selectionStartLine)}:${String(message.selectionStartColumn)}`
        );
      case "presenceLeft":
        return `presenceLeft:${String(message.clientId)}`;
      case "resyncRequest":
        // Sem campo variável — cada clique gera a mesma assinatura. Isso é
        // deliberado: um duplo-clique acidental no botão do painel (2 Studios
        // reportando o MESMO clique, cenário multiSync) deve mesmo ser
        // dedupido dentro da janela, evitando dois modais de confirmação
        // empilhados para o mesmo pedido lógico.
        return "resyncRequest";
      default:
        return `${message.kind}:${JSON.stringify(message)}`;
    }
  }

  private routeSpontaneous(message: RawMessage): void {
    // multiSync: dedupe de duplicidade de origem (2+ Studios reportando a
    // mesma mudança). Só ativo quando `multiSync` — com o default (false) o
    // comportamento é EXATAMENTE o de antes (nenhuma checagem aqui), porque
    // só existe 1 plugin conectado por vez nesse modo, então duas mensagens
    // "iguais" seguidas são sempre eventos distintos de verdade, nunca eco.
    if (this.multiSync) {
      const signature = this.computeSpontaneousSignature(message);
      const now = Date.now();
      if (signature === this.lastSpontaneousSignature && now - this.lastSpontaneousAt <= SPONTANEOUS_DEDUPE_WINDOW_MS) {
        this.logger.info(`multiSync: mensagem espontânea duplicada (${message.kind}) descartada (dedupe)`);
        return;
      }
      this.lastSpontaneousSignature = signature;
      this.lastSpontaneousAt = now;
    }

    switch (message.kind) {
      // Estes 4 kinds mutam estado compartilhado do SyncBridge (scripts/
      // diskPathByUuid/uuidByDiskPath/contentCache) e tocam disco — passam
      // pela fila FIFO (`enqueueMutation`, ver comentário no campo
      // `queueTail`) para nunca rodar concorrentemente com outra mensagem da
      // MESMA rajada nem com uma edição local concorrente
      // (`notifyLocalFileChange`). Continuam fire-and-forget do ponto de
      // vista de quem chama `routeSpontaneous` (retorna `void`) — só a ORDEM
      // de execução mudou, não a assinatura.
      case "sourceChanged":
        this.enqueueMutation(() => this.bridge.handleSourceChanged(message)).catch((error: Error) =>
          this.logger.error(`sourceChanged: ${error.message}`),
        );
        break;
      case "scriptAdded":
        this.enqueueMutation(() => this.bridge.handleScriptAdded(message, this.transport)).catch((error: Error) =>
          this.logger.error(`scriptAdded: ${error.message}`),
        );
        break;
      case "scriptMoved":
        this.enqueueMutation(() => this.bridge.handleScriptMoved(message)).catch((error: Error) =>
          this.logger.error(`scriptMoved: ${error.message}`),
        );
        break;
      case "scriptRemoved":
        this.enqueueMutation(() => this.bridge.handleScriptRemoved(message)).catch((error: Error) =>
          this.logger.error(`scriptRemoved: ${error.message}`),
        );
        break;
      case "leaseChanged":
        this.handleLeaseChanged(message);
        break;
      case "presenceChanged":
        this.handlePresenceChanged(message);
        break;
      case "presenceLeft":
        this.handlePresenceLeft(message);
        break;
      case "log":
        this.handleLog(message);
        break;
      case "resyncRequest":
        this.handleResyncRequest();
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

  /**
   * `presenceChanged {clientId, displayName, uuid, cursorLine, cursorColumn,
   * selectionStartLine, selectionStartColumn}` — presença de uma sessão
   * remota (nunca a própria, ver protocol.ts). Mesma lição do M3.3
   * (leaseChanged): campos `T | null` que vêm de uma tabela Lua serializada
   * por `HttpService:JSONEncode` chegam como campo AUSENTE quando o valor
   * Lua é `nil`, nunca como `null` — normaliza `undefined -> null` antes de
   * validar.
   */
  private handlePresenceChanged(message: RawMessage): void {
    const clientId = message.clientId;
    const displayName = message.displayName;
    const uuid = message.uuid ?? null;
    const cursorLine = message.cursorLine ?? null;
    const cursorColumn = message.cursorColumn ?? null;
    const selectionStartLine = message.selectionStartLine ?? null;
    const selectionStartColumn = message.selectionStartColumn ?? null;

    if (typeof clientId !== "string" || clientId.length === 0) {
      this.logger.error("presenceChanged sem clientId válido, ignorado");
      return;
    }
    if (typeof displayName !== "string" || displayName.length === 0) {
      this.logger.error("presenceChanged sem displayName válido, ignorado");
      return;
    }
    if (uuid !== null && typeof uuid !== "string") {
      this.logger.error("presenceChanged com uuid inválido, ignorado");
      return;
    }
    const numericFields: Array<[string, unknown]> = [
      ["cursorLine", cursorLine],
      ["cursorColumn", cursorColumn],
      ["selectionStartLine", selectionStartLine],
      ["selectionStartColumn", selectionStartColumn],
    ];
    for (const [name, value] of numericFields) {
      if (value !== null && typeof value !== "number") {
        this.logger.error(`presenceChanged com ${name} inválido, ignorado`);
        return;
      }
    }

    this.onPresenceChanged?.({
      clientId,
      displayName,
      uuid: uuid as string | null,
      cursorLine: cursorLine as number | null,
      cursorColumn: cursorColumn as number | null,
      selectionStartLine: selectionStartLine as number | null,
      selectionStartColumn: selectionStartColumn as number | null,
    });
  }

  /** `presenceLeft {clientId}` — sessão remota saiu ou expirou. */
  private handlePresenceLeft(message: RawMessage): void {
    const clientId = message.clientId;
    if (typeof clientId !== "string" || clientId.length === 0) {
      this.logger.error("presenceLeft sem clientId válido, ignorado");
      return;
    }
    this.onPresenceLeft?.({ clientId });
  }

  /**
   * Mensagem espontânea `{kind: "log", text}`: encaminha para o próprio
   * logger do serviço com o prefixo `[studio]` para diferenciar de longe de
   * logs gerados pelo harness/extensão em si. `text` já vem com o prefixo
   * `[SyncTeam HH:MM:SS]` de dentro do plugin (é a mesma string que apareceria
   * no Output do Studio) — não reformatamos, só prefixamos a origem. Existe
   * para permitir testar o projeto sem depender do usuário copiar/colar o
   * Output do Studio (ver .claude/rules/typescript.md e a tarefa que criou
   * `createFileLogger`/`createTeeLogger` em util/logger.ts).
   */
  private handleLog(message: RawMessage): void {
    const text = message.text;
    if (typeof text !== "string") {
      this.logger.error("mensagem 'log' sem campo 'text' válido, ignorada");
      return;
    }
    this.logger.info(`[studio] ${text}`);
  }

  /**
   * `resyncRequest` (2026-08-02, "ReSync" — ver docs/DECISIONS.md "5ª
   * rodada"): o Studio pediu um reset forçado (apagar todo Source
   * sincronizado e repuxar do zero). ANTES de apagar qualquer coisa, mostra
   * uma confirmação modal ao usuário LOCAL (via `onConfirmResync` — quem
   * clicou foi o Studio, mas quem perde o arquivo local é este lado, então
   * quem confirma de fato é este lado). Nunca deixa o pedido sem resposta:
   * toda saída (recusa por falta de confirmador, cancelamento, sucesso, erro)
   * manda `resyncResult` de volta — senão o botão do painel do Studio fica
   * travado em "syncing" para sempre.
   */
  private handleResyncRequest(): void {
    if (!this.onConfirmResync) {
      this.logger.error("resyncRequest: nenhum confirmador de UI registrado — recusando por segurança, nada foi apagado");
      this.server.sendSpontaneous({ kind: "resyncResult", ok: false, reason: "no_confirm_handler" });
      return;
    }

    const message =
      "SyncTeam: ReSync solicitado pelo Studio — isso vai apagar e recriar todos os arquivos de Source " +
      "sincronizados neste workspace, removendo qualquer duplicata. Continuar?";

    this.onConfirmResync(message)
      .then((confirmed) => {
        if (!confirmed) {
          this.logger.info("resyncRequest: cancelado pelo usuário — nada apagado");
          this.server.sendSpontaneous({ kind: "resyncResult", ok: false, reason: "cancelled_by_user" });
          return;
        }
        return this.enqueueMutation(() => this.bridge.resyncFromScratch(this.transport)).then((deletedCount) => {
          this.logger.info(`resyncRequest: concluído — ${deletedCount} arquivo(s) apagado(s), sincronização inicial repuxada`);
          this.server.sendSpontaneous({ kind: "resyncResult", ok: true, deletedCount });
        });
      })
      .catch((error: Error) => {
        // Nunca deixa a exceção subir sem resposta — o plugin precisa saber
        // que o ReSync não aconteceu, seja falha na confirmação em si ou no
        // reset (resyncFromScratch/runInitialSync).
        this.logger.error(`resyncRequest: falha — ${error.message}`);
        this.server.sendSpontaneous({ kind: "resyncResult", ok: false, reason: error.message });
      });
  }

  start(): Promise<void> {
    return this.server.start();
  }

  stop(): Promise<void> {
    return this.server.stop();
  }

  /**
   * Chamado pelo watcher de arquivos (fs.watch ou vscode.FileSystemWatcher) da
   * camada de ativação. Passa pela MESMA fila FIFO (`enqueueMutation`) que os
   * kinds espontâneos mutantes de `routeSpontaneous` — `handleLocalFileChange`
   * mexe nos MESMOS mapas compartilhados do SyncBridge, então uma edição local
   * concorrente com uma rajada de mensagens do Studio tem o mesmo tipo de
   * corrida (ver comentário no campo `queueTail`).
   */
  notifyLocalFileChange(relDiskPath: string): void {
    this.enqueueMutation(() => this.bridge.handleLocalFileChange(relDiskPath, this.transport)).catch((error: Error) => {
      this.logger.error(`disco → Studio: erro processando mudança local '${relDiskPath}': ${error.message}`);
    });
  }

  /**
   * Chamado pelo listener `onDidChangeTextDocument` (buffer do editor,
   * throttled) da camada de ativação — ver `SyncBridge.handleBufferContentChange`
   * para o contrato completo (2026-08-02, "handoff quase-instantâneo de
   * lease", docs/DECISIONS.md "8ª rodada"). Mesma fila FIFO
   * (`enqueueMutation`) que `notifyLocalFileChange`/`routeSpontaneous` — mexe
   * nos mesmos mapas compartilhados do `SyncBridge`, então uma pulsação de
   * buffer concorrente com uma rajada de mensagens do Studio (ou com o
   * próprio save) tem o mesmo tipo de corrida.
   */
  notifyBufferChange(relDiskPath: string, content: string): void {
    this.enqueueMutation(() => this.bridge.handleBufferContentChange(relDiskPath, content, this.transport)).catch((error: Error) => {
      this.logger.error(`buffer → Studio: erro processando mudança de buffer '${relDiskPath}': ${error.message}`);
    });
  }
}
