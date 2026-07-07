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
