// SyncTeam — protocolo de mensagens entre a extensão VS Code (servidor
// WebSocket) e o plugin Studio (cliente). Ver docs/ARCHITECTURE.md e a regra
// de protocolo em .claude/rules/typescript.md: toda mensagem tem `kind`
// obrigatório; requisições/respostas usam `requestId`; mensagem inválida é
// logada e descartada, nunca derruba o servidor.
//
// Versionado desde o início (M1): plugin manda `hello` com
// `protocolVersion`; a extensão rejeita/avisa em mismatch em vez de
// prosseguir silenciosamente (ver SyncServer.ts).
//
// v2 (M2, breaking change deliberado — ver docs/MILESTONES.md): script deixa
// de ser endereçado por caminho completo no DataModel (frágil a rename/move)
// e passa a ser endereçado por UUID, alocado e mantido pelo plugin
// (TestService.SyncTeam.Scripts.<uuid> do lado do Studio). `path` continua
// presente nas mensagens só como informação de exibição/log — nunca mais
// como chave de lookup.

export const PROTOCOL_VERSION = 2;

export type ScriptClassName = "Script" | "LocalScript" | "ModuleScript";

export function isValidClassName(value: unknown): value is ScriptClassName {
  return value === "Script" || value === "LocalScript" || value === "ModuleScript";
}

export interface HelloMessage {
  kind: "hello";
  protocolVersion: number;
  role: "studio";
  placeName?: string;
  userId?: number;
  pluginVersion?: string;
  clientId?: string | null;
}

export interface ListScriptsRequest {
  kind: "listScripts";
  requestId: string;
}

export interface ScriptListEntry {
  uuid: string;
  /** Informativo/exibição (layout em disco e logs) — nunca chave de lookup. */
  path: string;
  className: ScriptClassName;
}

export interface ScriptListResponse {
  kind: "scriptList";
  requestId: string;
  scripts: ScriptListEntry[];
}

export interface ReadSourceRequest {
  kind: "readSource";
  requestId: string;
  uuid: string;
}

export interface SourceContentResponse {
  kind: "sourceContent";
  requestId: string;
  ok: boolean;
  source?: string;
  error?: string;
}

/** writeSource, modo "atualizar": script já conhecido pelo plugin (uuid presente). */
export interface WriteSourceUpdateRequest {
  kind: "writeSource";
  requestId: string;
  uuid: string;
  source: string;
}

/** writeSource, modo "criar": script novo — o plugin aloca um uuid e cria a Instance. */
export interface WriteSourceCreateRequest {
  kind: "writeSource";
  requestId: string;
  path: string;
  className: ScriptClassName;
  source: string;
}

/**
 * União discriminada por presença de campo (`uuid` XOR `path`+`className`) em
 * vez de todos os campos opcionais soltos — o compilador pega uso incorreto
 * (ex.: tentar ler `.path` no modo atualizar) em vez de deixar passar como
 * `undefined` silencioso.
 */
export type WriteSourceRequest = WriteSourceUpdateRequest | WriteSourceCreateRequest;

export function isWriteSourceUpdate(message: WriteSourceRequest): message is WriteSourceUpdateRequest {
  return "uuid" in message;
}

export interface WriteAckResponse {
  kind: "writeAck";
  requestId: string;
  ok: boolean;
  /** Sempre presente quando `ok === true`: o uuid enviado (atualizar) ou o recém-alocado (criar). */
  uuid?: string;
  api?: string;
  error?: string;
}

export interface SourceChangedEvent {
  kind: "sourceChanged";
  uuid: string;
  /** Informativo/exibição — o handler resolve o diskPath pelo `uuid`, nunca por este campo. */
  path: string;
  source: string;
  className: ScriptClassName;
  origin?: string;
  via?: string;
}

export interface ScriptAddedEvent {
  kind: "scriptAdded";
  uuid: string;
  path: string;
  className: ScriptClassName;
}

export interface ScriptRemovedEvent {
  kind: "scriptRemoved";
  uuid: string;
  path: string;
}

/**
 * Extensão → plugin (2026-07-20, aditiva — NÃO muda `PROTOCOL_VERSION`, mesmo
 * precedente de `ping`/`leaseChanged`): manda quando um arquivo mapeado some
 * do disco (delete local, ou a metade "delete" de um rename local sem
 * correlação — ver `SyncBridge.handleLocalFileRemoved`) e há um uuid
 * conhecido para aquele diskPath. Pede ao plugin para destruir a Instance
 * correspondente no Studio. Responde reusando `writeAck` (mesmo padrão de
 * `writeSource` — `transport.request()` correlaciona só por `requestId`, não
 * por `kind`): `uuid` presente quando `ok=true` (o mesmo uuid deletado);
 * `error` presente quando `ok=false` (ex.: uuid desconhecido, ou script
 * dentro de pasta de pacote vendorizado, que o plugin bloqueia igual já faz
 * para updates).
 */
export interface DeleteScriptRequest {
  kind: "deleteScript";
  requestId: string;
  uuid: string;
}

/**
 * Espontânea (M2, nova): o plugin detecta rename/move do lado do Studio (via
 * `ObjectValue`/caminho canônico mudando para o mesmo uuid) e manda esta
 * mensagem em vez de um par scriptRemoved+scriptAdded — preserva a
 * identidade e permite mover o arquivo físico em vez de recriar do zero.
 */
export interface ScriptMovedEvent {
  kind: "scriptMoved";
  uuid: string;
  oldPath: string;
  newPath: string;
  className: ScriptClassName;
}

/**
 * Espontânea (M3.2, nova): o plugin manda esta mensagem quando o estado de
 * uma lease muda (nova lease atribuída, renovada, ou liberada).
 * `ownerClientId: null` significa "a lease foi liberada, ninguém é dono agora".
 */
export interface LeaseChangedEvent {
  kind: "leaseChanged";
  uuid: string;
  ownerClientId: string | null;
  ownerDisplayName: string | null;
}

/**
 * Extensão → plugin (M4, nova, aditiva — não muda `PROTOCOL_VERSION`, mesmo
 * precedente de `leaseChanged`/`hello.clientId` no M3): mensagem espontânea
 * (sem `requestId`/ack, mesmo mecanismo de `SyncServer.sendSpontaneous` usado
 * para mandar isso) publicando o cursor/seleção/arquivo ativo do dev LOCAL.
 * `uuid: null` significa "nenhum script sincronizado conhecido está ativo"
 * (limpar minha presença) — sem editor ativo cai no mesmo caso.
 */
export interface PresenceUpdateMessage {
  kind: "presenceUpdate";
  uuid: string | null;
  cursorLine: number | null;
  cursorColumn: number | null;
  selectionStartLine: number | null;
  selectionStartColumn: number | null;
}

/**
 * Plugin → extensão (M4, nova), espontânea, uma por sessão remota que
 * mudou — o plugin nunca manda a presença da PRÓPRIA sessão de volta (mesmo
 * espírito de `leaseChanged`). `uuid: null` = colaborador sem script
 * sincronizado ativo.
 */
export interface PresenceChangedEvent {
  kind: "presenceChanged";
  clientId: string;
  displayName: string;
  uuid: string | null;
  cursorLine: number | null;
  cursorColumn: number | null;
  selectionStartLine: number | null;
  selectionStartColumn: number | null;
}

/** Plugin → extensão (M4, nova), espontânea: sessão remota saiu ou expirou. */
export interface PresenceLeftEvent {
  kind: "presenceLeft";
  clientId: string;
}

/**
 * Extensão → plugin, espontânea: impressão digital do `wally.toml` local.
 *
 * Não é o conteúdo do arquivo e não deve virar um: `Packages/` fica fora do
 * sync de propósito, e sincronizar o manifesto sem os pacotes só trocaria um
 * estado inconsistente por outro. O que atravessa é a informação mínima para
 * o outro lado saber que DIVERGE — ver plugin/src/TeamCreateWally.luau.
 */
export interface WallyFingerprintMessage {
  kind: "wallyFingerprint";
  value: string;
}

/**
 * Plugin → extensão, espontânea: um colaborador está com dependências Wally
 * diferentes das suas. Quem instala é o dev, nunca o SyncTeam.
 */
export interface WallyDriftEvent {
  kind: "wallyDrift";
  clientId: string;
  displayName: string;
}

/**
 * Extensão → plugin (heartbeat, aditiva — NÃO muda `PROTOCOL_VERSION`, mesmo
 * precedente de `leaseChanged`/`presenceUpdate`): ping periódico de vida,
 * enviado a cada `HEARTBEAT_INTERVAL_MS` pelo `SyncServer`. Espontânea (sem
 * `requestId`/ack — vai por `SyncServer.send`). O plugin DEVE responder com
 * `pong`; qualquer outra mensagem do plugin também reseta o relógio de silêncio
 * do lado da extensão. Serve para detectar queda de conexão que o socket TCP
 * não avisou (ex.: processo da extensão morto num "Reload Window" — o cliente
 * do plugin não recebe frame de close e ficaria "conectado" para sempre). Ver
 * .claude/agent-memory/extension-dev.md para o contrato exato (intervalo/
 * timeout) que o lado Luau precisa espelhar.
 */
export interface PingMessage {
  kind: "ping";
}

/**
 * Plugin → extensão (heartbeat): resposta ao `ping`. A extensão a trata só
 * como sinal de vida (reseta o relógio de silêncio) e NÃO a roteia como
 * mensagem espontânea. Qualquer outra mensagem do plugin cumpre o mesmo papel.
 */
export interface PongMessage {
  kind: "pong";
}

/**
 * Extensão → plugin (aditiva — NÃO muda `PROTOCOL_VERSION`, mesmo precedente de
 * `leaseChanged`/`ping`): enviada IMEDIATAMENTE ANTES de o servidor fechar uma
 * conexão rejeitada, porque o lado do plugin (`WebStreamClient`) não consegue
 * ler o close code nem o reason de um close (o evento `Closed()` do Luau não
 * tem parâmetro — .claude/research/2026-07-15-webstreamclient-close-code.md).
 * Uma mensagem de aplicação (`MessageReceived`) é o único canal que carrega o
 * motivo até o plugin. `reason` é string (não booleano) para poder crescer no
 * futuro; hoje o único valor é `"port_in_use"` (já existe outro plugin
 * conectado nesta porta / servidor local).
 */
export interface ConnectionRejectedMessage {
  kind: "connectionRejected";
  reason: "port_in_use";
}

/**
 * Extensão → plugin (2026-07-29, aditiva — NÃO muda `PROTOCOL_VERSION`, mesmo
 * precedente de `ping`/`leaseChanged`/`presenceUpdate`/`connectionRejected`).
 *
 * Contexto: o plugin Studio (Luau) roda no sandbox do Roblox e não tem acesso
 * ao `default.project.json` — só a extensão VS Code lê/parseia esse arquivo
 * (ver `mapping/projectMapping.ts::parseMountPoints`). Até aqui o plugin
 * dependia de uma tabela FIXA hardcoded de "watched roots"
 * (`plugin/src/Config.luau`, `Config.getWatchedRoots()`) para saber quais
 * serviços do DataModel escanear — qualquer mount point novo apontando para um
 * serviço fora dessa lista fixa (ex.: `ReplicatedFirst`, `Lighting`, `Teams`,
 * `Chat`, `SoundService`) simplesmente não sincronizava (bug real relatado
 * 2026-07-29, ver docs/DECISIONS.md mesma data).
 *
 * `roots`: lista ÚNICA (sem duplicata) dos nomes de serviço de TOPO (primeiro
 * segmento de `dataModelPath`, ex.: "ReplicatedFirst" de
 * "ReplicatedFirst/First") referenciados por qualquer ponto de montagem do
 * `default.project.json` do projeto ATUAL — ver
 * `mapping/projectMapping.ts::computeWatchedRoots`.
 *
 * QUANDO é mandada: exatamente UMA vez por conexão aceita, logo depois que o
 * `hello` do plugin é validado (protocolVersion compatível) — e sempre ANTES
 * do primeiro `listScripts` da sincronização inicial (`runInitialSync`), para
 * que o plugin já saiba quais containers escanear antes de precisar reportar
 * `scriptList`. Ver `SyncTeamService`'s `onClientConnected` handler (chamado
 * de dentro de `SyncServer.handleHello`) — a mensagem é enviada via
 * `server.sendSpontaneous(...)` IMEDIATAMENTE antes de enfileirar
 * `bridge.runInitialSync(...)`.
 *
 * O QUE o plugin deve fazer com ela (a implementar pelo luau-dev): usar esta
 * lista EM VEZ da tabela fixa local dele para decidir quais serviços do
 * DataModel escanear/observar. A tabela fixa (`Config.getWatchedRoots()`)
 * deve virar só um FALLBACK/default para quando esta mensagem nunca chegar
 * (ex.: plugin mais novo/mais velho que a extensão, ou algum erro que impeça
 * o recebimento) — nunca mais a fonte de verdade quando a mensagem chegou.
 */
export interface WatchedRootsMessage {
  kind: "watchedRoots";
  roots: string[];
}

/**
 * Plugin → extensão (2026-08-02, "ReSync" — ver docs/DECISIONS.md, entrada
 * "5ª rodada", aditiva — NÃO muda `PROTOCOL_VERSION`, mesmo precedente de
 * `ping`/`leaseChanged`/`watchedRoots`). Espontânea, sem `requestId`/ack:
 * disparada quando o usuário clica no botão "RESYNC" do painel do plugin no
 * Studio. Pede um reset forçado — apagar TODO Source sincronizado no
 * workspace do VS Code e repuxar tudo de novo do Studio (autoritativo),
 * eliminando qualquer arquivo duplicado/órfão. Mais agressivo que
 * `refreshSync`/comando "Refresh Sync" (reconciliação de 3 vias,
 * não-destrutiva) — este é um reset completo para quando o estado ficou
 * bagunçado o bastante (duplicatas) que a reconciliação não resolve. A
 * extensão SEMPRE confirma com o usuário local (modal nativa) antes de
 * apagar qualquer coisa — ver `SyncTeamService`'s `handleResyncRequest`.
 */
export interface ResyncRequestMessage {
  kind: "resyncRequest";
}

/**
 * Extensão → plugin (2026-08-02, "ReSync"), espontânea: resposta ao
 * `resyncRequest`. `ok: false` cobre tanto "usuário cancelou a confirmação"
 * (`reason: "cancelled_by_user"`) quanto qualquer erro real durante o reset
 * (`reason` = mensagem do erro) — nunca deixamos o pedido sem resposta,
 * senão o botão do painel do Studio fica travado em "syncing" para sempre.
 * `deletedCount` só está presente quando `ok === true` (quantos arquivos
 * foram de fato apagados antes de repuxar tudo do zero).
 */
export interface ResyncResultMessage {
  kind: "resyncResult";
  ok: boolean;
  deletedCount?: number;
  reason?: string;
}

/**
 * Mensagem recebida crua, só com a garantia de que `kind` é uma string não
 * vazia — todo o resto é validado por quem consome cada `kind` específico
 * (nunca confiar na forma do payload sem checar os campos).
 */
export type RawMessage = { kind: string } & Record<string, unknown>;

/**
 * Faz o parse de uma mensagem recebida pelo WebSocket e garante o único
 * invariante estrutural do protocolo (`kind` string não vazia). Retorna
 * `null` para JSON malformado, payload que não é objeto, ou `kind` ausente —
 * nesses casos quem chamou deve logar e descartar, nunca lançar.
 */
export function parseIncomingMessage(raw: string): RawMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.kind !== "string" || obj.kind.length === 0) {
    return null;
  }
  return obj as RawMessage;
}
