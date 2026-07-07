// SyncTeam — servidor WebSocket local que o plugin Studio conecta como
// cliente. Regra de .claude/rules/typescript.md: bind exclusivo em
// 127.0.0.1, porta configurável com default fixo; toda mensagem validada
// antes de usar; mensagem inválida é logada e descartada, nunca derruba o
// servidor.
//
// M1 é 1 dev só: apenas 1 plugin deveria conectar. Uma segunda tentativa de
// conexão é rejeitada com log claro em vez de silenciosamente substituir a
// primeira (evitaria dois "donos" concorrentes do mesmo estado local).

import { WebSocketServer, type WebSocket } from "ws";
import { PROTOCOL_VERSION, parseIncomingMessage, type RawMessage } from "../protocol.js";
import type { Logger } from "../util/logger.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

export interface SyncServerHandlers {
  /** Chamado depois que um `hello` com protocolVersion compatível é aceito. */
  onClientConnected(hello: RawMessage): void;
  onClientDisconnected(): void;
  /** Mensagens espontâneas (sourceChanged/scriptAdded/scriptRemoved/etc.) que não são resposta a nenhum request pendente. */
  onSpontaneous(message: RawMessage): void;
}

interface PendingRequest {
  resolve: (message: RawMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class SyncServer {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private handlers: SyncServerHandlers | null = null;

  constructor(
    private readonly port: number,
    private readonly logger: Logger,
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

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
    this.rejectAllPending(new Error("servidor SyncTeam encerrado"));
    this.client?.close();
    this.client = null;
    const wss = this.wss;
    this.wss = null;
    if (!wss) {
      return;
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  isClientConnected(): boolean {
    return this.client !== null && this.client.readyState === this.client.OPEN;
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

  private send(message: Record<string, unknown>): boolean {
    if (!this.client || this.client.readyState !== this.client.OPEN) {
      this.logger.info(`mensagem descartada (nenhum plugin conectado): ${String(message.kind)}`);
      return false;
    }
    this.client.send(JSON.stringify(message));
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
    if (this.client && this.client.readyState === this.client.OPEN) {
      this.logger.error(
        "segundo plugin tentou conectar — SyncTeam M1 suporta apenas 1 plugin conectado por vez; fechando a nova conexão",
      );
      socket.close(1013, "SyncTeam: já existe um plugin conectado");
      return;
    }

    let helloReceived = false;

    socket.on("message", (data: Buffer | string) => {
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

      if (this.resolvePending(message)) {
        return;
      }
      this.handlers?.onSpontaneous(message);
    });

    socket.on("close", () => {
      if (this.client === socket) {
        this.client = null;
        this.rejectAllPending(new Error("plugin desconectou"));
        this.handlers?.onClientDisconnected();
        this.logger.info("plugin desconectou");
      }
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
      this.logger.error(
        `plugin conectou com protocolVersion=${String(message.protocolVersion)}, esperado ${PROTOCOL_VERSION} — ` +
          "não prosseguindo com este cliente (verifique se plugin e extensão estão na mesma versão do protocolo)",
      );
      socket.close(1002, "protocolVersion incompatível");
      return;
    }
    markReceived();
    this.client = socket;
    this.logger.info(
      `plugin conectado (role=${String(message.role)}, place=${String(message.placeName)}, userId=${String(message.userId)}, pluginVersion=${String(message.pluginVersion)})`,
    );
    this.handlers?.onClientConnected(message);
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
