// SyncTeam — servidor WebSocket local que o plugin Studio conecta como
// cliente. Regra de .claude/rules/typescript.md: bind exclusivo em
// 127.0.0.1, porta configurável com default fixo; toda mensagem validada
// antes de usar; mensagem inválida é logada e descartada, nunca derruba o
// servidor.
//
// Default (`multiSync=false`): apenas 1 plugin deveria conectar. Uma segunda
// tentativa de conexão é rejeitada com log claro em vez de silenciosamente
// substituir a primeira (evitaria dois "donos" concorrentes do mesmo estado
// local).
//
// `multiSync=true` (2026-07-15, pedido do usuário): permite N plugins
// conectados na MESMA porta/extensão — cenário real: 1 dev com 2 contas
// Roblox/2 Studios na mesma máquina testando multiplayer, sincronizando os
// dois com 1 VS Code só. Justificativa de correção: os Studios conectados
// nesse cenário estão todos na MESMA place via Team Create, então mandar a
// mesma escrita/intenção pra todos é redundante mas inofensivo (Team Create
// já mantém eles convergentes). Ver `.claude/agent-memory/extension-dev.md`
// para o desenho completo (broadcast de saída, primeira-resposta-vence em
// `request()`, dedupe de espontânea duplicada em SyncTeamService).

import { WebSocketServer, type WebSocket } from "ws";
import { PROTOCOL_VERSION, parseIncomingMessage, type RawMessage } from "../protocol.js";
import type { Logger } from "../util/logger.js";
import { HeartbeatMonitor } from "./HeartbeatMonitor.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

// Heartbeat da conexão local (extensão ↔ plugin). Localhost, então o custo de
// um ping a cada 5s é irrisório; o timeout de 15s (3x o intervalo) tolera até
// dois pings perdidos antes de declarar a conexão morta, evitando falso
// positivo por um engasgo transitório do Studio. Ver
// .claude/agent-memory/extension-dev.md e HeartbeatMonitor.ts.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15000;

export interface SyncServerOptions {
  /** Timeout (ms) das requisições request()/resposta correlacionada. Default 10000. */
  requestTimeoutMs?: number;
  /** Intervalo (ms) entre pings de heartbeat ao plugin. Default 5000. */
  heartbeatIntervalMs?: number;
  /** Silêncio máximo (ms) sem mensagem do plugin antes de declarar a conexão morta. Default 15000. */
  heartbeatTimeoutMs?: number;
  /**
   * Permite múltiplos plugins conectados simultaneamente na mesma porta
   * (`syncteam.multiSync`). Default `false`: comportamento de sempre — uma 2ª
   * conexão é rejeitada com `connectionRejected`/`port_in_use`.
   */
  multiSync?: boolean;
}

export interface SyncServerHandlers {
  /** Chamado depois que um `hello` com protocolVersion compatível é aceito. */
  onClientConnected(hello: RawMessage): void;
  onClientDisconnected(): void;
  /** Mensagens espontâneas (sourceChanged/scriptAdded/scriptRemoved/etc.) que não são resposta a nenhum request pendente. */
  onSpontaneous(message: RawMessage): void;
  /**
   * Chamado quando um plugin é REJEITADO por erro de protocolo (hoje só
   * protocolVersion incompatível) — antes de `onClientConnected`, portanto
   * nunca há transição de estado "conectado" para este cliente. Permite à
   * camada de ativação mostrar um aviso visível. Opcional.
   */
  onProtocolError?(message: string): void;
}

interface PendingRequest {
  resolve: (message: RawMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class SyncServer {
  private wss: WebSocketServer | null = null;
  // Um ou mais plugins conectados (hello aceito). Com `multiSync=false`
  // (default) este Set nunca tem mais de 1 elemento — a rejeição em
  // `handleConnection` garante isso antes de qualquer hello ser processado.
  private readonly clients = new Set<WebSocket>();
  private readonly heartbeats = new Map<WebSocket, HeartbeatMonitor>();
  private readonly pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private handlers: SyncServerHandlers | null = null;
  private readonly requestTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly multiSync: boolean;

  constructor(
    private readonly port: number,
    private readonly logger: Logger,
    options: SyncServerOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.multiSync = options.multiSync ?? false;
  }

  setHandlers(handlers: SyncServerHandlers): void {
    this.handlers = handlers;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port: this.port });
      this.wss = wss;
      const onListening = () => {
        this.logger.info(`servidor WebSocket ouvindo em ws://127.0.0.1:${this.port}`);
        resolve();
      };
      const onFirstError = (error: Error) => {
        reject(error);
      };
      wss.once("listening", onListening);
      wss.once("error", onFirstError);
      wss.on("connection", (socket) => this.handleConnection(socket));
      wss.on("error", (error) => this.logger.error(`erro do servidor WebSocket: ${error.message}`));
    });
  }

  async stop(): Promise<void> {
    for (const heartbeat of this.heartbeats.values()) {
      heartbeat.stop();
    }
    this.heartbeats.clear();
    this.rejectAllPending(new Error("servidor SyncTeam encerrado"));
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    const wss = this.wss;
    this.wss = null;
    if (!wss) {
      return;
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  /** Algum plugin conectado agora (aberto de fato, hello aceito)? */
  isClientConnected(): boolean {
    return this.openClients().length > 0;
  }

  /** Quantos plugins estão conectados agora (útil quando `multiSync=true`). */
  getConnectedCount(): number {
    return this.openClients().length;
  }

  private openClients(): WebSocket[] {
    return [...this.clients].filter((client) => client.readyState === client.OPEN);
  }

  /** Envia `message` e espera a resposta correlacionada por `requestId` (gerado se ausente). */
  request(message: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<RawMessage> {
    const requestId = typeof message.requestId === "string" ? message.requestId : `syncteam-${++this.requestCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`timeout (${timeoutMs}ms) esperando resposta de '${String(message.kind)}' (${requestId})`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      const sent = this.send({ ...message, requestId });
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error("nenhum plugin conectado"));
      }
    });
  }

  /**
   * Envia `message` sem esperar resposta (mensagem espontânea deste lado
   * PARA o plugin — ex.: `presenceUpdate`, M4). Diferente de `request()`:
   * não gera `requestId`, não registra callback pendente, não pode dar
   * timeout. Silenciosamente descartada (com log informativo, mesmo
   * comportamento de `send` hoje) se nenhum plugin estiver conectado.
   */
  sendSpontaneous(message: Record<string, unknown>): void {
    this.send(message);
  }

  /**
   * Broadcast: envia `message` a TODOS os plugins conectados. Com
   * `multiSync=false` só há no máximo 1 cliente, então isso é idêntico ao
   * comportamento de sempre. Com `multiSync=true`, mandar a mesma
   * escrita/intenção pra todos é redundante mas inofensivo (Team Create já
   * mantém os Studios convergentes; um `writeSource` duplicado com o mesmo
   * uuid+conteúdo é um no-op no 2º Studio).
   */
  private send(message: Record<string, unknown>): boolean {
    const targets = this.openClients();
    if (targets.length === 0) {
      this.logger.info(`mensagem descartada (nenhum plugin conectado): ${String(message.kind)}`);
      return false;
    }
    const payload = JSON.stringify(message);
    for (const client of targets) {
      client.send(payload);
    }
    return true;
  }

  private rejectAllPending(error: Error): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.pending.delete(id);
    }
  }

  private handleConnection(socket: WebSocket): void {
    if (!this.multiSync && this.openClients().length > 0) {
      this.logger.error(
        "segundo plugin tentou conectar — syncteam.multiSync está desligado (1 plugin por vez); fechando a nova conexão " +
          "(ligue 'syncteam.multiSync' se quiser sincronizar vários Studios com esta mesma extensão)",
      );
      // O lado do plugin (WebStreamClient) NÃO consegue ler o close code nem o
      // reason de um close — o evento `Closed()` do Luau não tem parâmetro
      // (doc oficial, .claude/research/2026-07-15-webstreamclient-close-code.md).
      // Por isso mandamos uma MENSAGEM de aplicação (que `MessageReceived`
      // recebe normalmente) com o motivo ANTES de fechar. Usamos o callback do
      // `send()` (biblioteca `ws`) para só fechar DEPOIS que o envio confirmar,
      // evitando que a mensagem se perca numa corrida entre `send` e `close`.
      socket.send(JSON.stringify({ kind: "connectionRejected", reason: "port_in_use" }), (err) => {
        if (err) {
          this.logger.error(`erro enviando connectionRejected: ${err.message}`);
        }
        socket.close(1013, "SyncTeam: já existe um plugin conectado");
      });
      return;
    }

    let helloReceived = false;

    socket.on("message", (data: Buffer | string) => {
      // Qualquer frame recebido do plugin prova que ESTA conexão está viva —
      // reseta o relógio de silêncio do heartbeat DESTE socket (no-op antes do
      // hello, quando o monitor ainda não existe para ele). Cada plugin tem
      // seu próprio HeartbeatMonitor (mapa `heartbeats`) — em multiSync, um
      // plugin silencioso não afeta o relógio dos demais.
      this.heartbeats.get(socket)?.recordActivity();

      const raw = data.toString();
      const message = parseIncomingMessage(raw);
      if (message === null) {
        this.logger.error(`mensagem inválida descartada (sem 'kind' ou JSON malformado): ${raw.slice(0, 200)}`);
        return;
      }

      if (message.kind === "hello") {
        this.handleHello(socket, message, helloReceived, () => {
          helloReceived = true;
        });
        return;
      }

      if (!helloReceived) {
        this.logger.error(`mensagem '${message.kind}' recebida antes de 'hello' — descartada`);
        return;
      }

      // Frames de heartbeat: o `pong` já cumpriu seu papel em recordActivity()
      // acima; não é evento espontâneo, então engolimos em silêncio para não
      // poluir o log com "kind desconhecido". Um `ping` vindo do plugin não faz
      // parte do contrato (heartbeat é extensão→plugin), mas se chegar
      // respondemos pong por robustez, sem propagar. Resposta vai SÓ para este
      // socket (não broadcast) — `this.send` é para mensagens que fazem
      // sentido pra todos os plugins, não para o eco de um ping individual.
      if (message.kind === "pong") {
        return;
      }
      if (message.kind === "ping") {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ kind: "pong" }));
        }
        return;
      }

      // Requisição/resposta correlacionada por requestId: em multiSync, a
      // mesma requisição foi mandada (broadcast) a todos os plugins, e mais de
      // uma resposta com o mesmo requestId pode voltar. `resolvePending`
      // resolve a Promise na PRIMEIRA e remove a entrada do mapa — uma 2ª
      // resposta não encontra mais a entrada (retorna false aqui) e cai no
      // fallback de `onSpontaneous`, onde é descartada com um log informativo
      // de "kind desconhecido" (nenhum erro, nenhum crash — ver
      // .claude/agent-memory/extension-dev.md).
      if (this.resolvePending(message)) {
        return;
      }
      this.handlers?.onSpontaneous(message);
    });

    socket.on("close", () => {
      if (!this.clients.has(socket)) {
        return; // nunca chegou a ser aceito (ex.: rejeitado por protocolVersion ou por multiSync=false)
      }
      this.heartbeats.get(socket)?.stop();
      this.heartbeats.delete(socket);
      this.clients.delete(socket);
      this.logger.info(`plugin desconectou (${this.clients.size} plugin(s) restante(s))`);
      // Só rejeita requisições pendentes quando NENHUM plugin resta — se
      // outros continuam conectados (multiSync), eles podem ainda responder à
      // mesma requisição broadcast, ou ela estoura no timeout normal.
      if (this.clients.size === 0) {
        this.rejectAllPending(new Error("plugin desconectou"));
      }
      this.handlers?.onClientDisconnected();
    });

    socket.on("error", (error: Error) => {
      this.logger.error(`erro no socket do plugin: ${error.message}`);
    });
  }

  private handleHello(socket: WebSocket, message: RawMessage, alreadyReceived: boolean, markReceived: () => void): void {
    if (alreadyReceived) {
      this.logger.info("hello duplicado recebido do mesmo cliente, ignorado");
      return;
    }
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      const detail =
        `plugin conectou com protocolVersion=${String(message.protocolVersion)}, esperado ${PROTOCOL_VERSION} — ` +
        "não prosseguindo com este cliente (verifique se plugin e extensão estão na mesma versão do protocolo)";
      this.logger.error(detail);
      this.handlers?.onProtocolError?.(
        `Plugin do Studio está numa versão de protocolo incompatível (recebido ${String(message.protocolVersion)}, ` +
          `esperado ${PROTOCOL_VERSION}). Atualize o plugin e a extensão para a mesma versão.`,
      );
      socket.close(1002, "protocolVersion incompatível");
      return;
    }
    markReceived();
    this.clients.add(socket);
    this.logger.info(
      `plugin conectado (role=${String(message.role)}, place=${String(message.placeName)}, userId=${String(message.userId)}, ` +
        `pluginVersion=${String(message.pluginVersion)}, clientId=${String(message.clientId ?? "(nenhum)")}) — ` +
        `${this.clients.size} plugin(s) conectado(s) agora`,
    );
    this.startHeartbeat(socket);
    this.handlers?.onClientConnected(message);
  }

  /**
   * Cria e inicia o monitor de heartbeat DESTE socket especificamente — cada
   * plugin conectado (multiSync) tem seu próprio `HeartbeatMonitor` no mapa
   * `heartbeats`, com `sendPing`/`onTimeout` fechados sobre ESTE `socket`
   * (nunca broadcast: o ping de um plugin não deve inundar os outros).
   * `onTimeout` força o fechamento do socket, o que dispara o handler de
   * `close` acima — caminho único de desconexão, seja por close normal, seja
   * por heartbeat.
   */
  private startHeartbeat(socket: WebSocket): void {
    this.heartbeats.get(socket)?.stop();
    const heartbeat = new HeartbeatMonitor({
      intervalMs: this.heartbeatIntervalMs,
      timeoutMs: this.heartbeatTimeoutMs,
      sendPing: () => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ kind: "ping" }));
        }
      },
      onTimeout: () => {
        // Força o fecho sem esperar handshake de close do peer (que pode estar
        // morto) — `terminate` destrói o socket e emite `close` de imediato.
        socket.terminate();
      },
      onDeadLog: (message) => this.logger.error(message),
    });
    this.heartbeats.set(socket, heartbeat);
    heartbeat.start();
  }

  private resolvePending(message: RawMessage): boolean {
    const requestId = message.requestId;
    if (typeof requestId !== "string") {
      return false;
    }
    const waiter = this.pending.get(requestId);
    if (!waiter) {
      return false;
    }
    this.pending.delete(requestId);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
    return true;
  }
}
