// Servidor de log do spike M1.6 (taxa de streaming de Source) — grava cada
// evento recebido dos dois papéis (escritor/observador, ver
// SyncTeamRateSpike.lua) com o timestamp de RECEBIMENTO deste próprio
// processo Node. Deliberadamente NÃO usa nenhum timestamp gerado dentro do
// Studio (ver comentário no topo do .lua sobre não depender de API Roblox
// não confirmada em .claude/research/) — como os dois Studios rodam na
// MESMA máquina e falam com o MESMO processo Node, o relógio deste processo
// é a única fonte de tempo, comparável entre os dois lados sem depender de
// nenhum relógio interno do Studio.
//
// Uso: node control-server.mjs [porta=35990] [arquivo-de-log]
// Puramente um logger burro — toda a lógica de ciclar pelas taxas mora no
// plugin (escritor autodirigido); este servidor só recebe, carimba e grava.
import { WebSocketServer } from "ws";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const PORT = Number(process.argv[2] ?? 35990);
const LOG_PATH = process.argv[3] ?? `./logs/rate-spike-${Date.now()}.jsonl`;

mkdirSync(dirname(LOG_PATH) || ".", { recursive: true });
const logStream = createWriteStream(LOG_PATH, { flags: "a" });

function recordLine(remote, msg) {
  const line = JSON.stringify({
    recvIso: new Date().toISOString(),
    recvMs: Date.now(),
    remote,
    msg,
  });
  logStream.write(line + "\n");
  console.log(`[rate-spike-server] ${remote}: ${JSON.stringify(msg)}`);
}

const server = new WebSocketServer({ host: "127.0.0.1", port: PORT });

server.on("listening", () => {
  console.log(`[rate-spike-server] ouvindo em ws://127.0.0.1:${PORT}`);
  console.log(`[rate-spike-server] gravando em ${LOG_PATH}`);
});

server.on("connection", (socket) => {
  let remote = "desconhecido";
  console.log("[rate-spike-server] Studio conectou");
  socket.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      console.error("[rate-spike-server] mensagem inválida (ignorada):", data.toString());
      return;
    }
    if (msg.kind === "hello" && typeof msg.role === "string") {
      remote = msg.role;
    }
    recordLine(remote, msg);
  });
  socket.on("close", () => console.log(`[rate-spike-server] conexão fechada (${remote})`));
  socket.on("error", (err) => console.error(`[rate-spike-server] erro de socket (${remote}):`, err.message));
});
