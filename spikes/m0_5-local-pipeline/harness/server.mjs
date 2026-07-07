// SyncTeam — Spike M0.5: harness que simula dois "VS Codes" (canais A e B).
// O plugin SyncTeamLab.lua conecta a ambas as portas; os cenários rodam
// automaticamente quando os dois canais estiverem conectados.
//
// Uso: npm install && node server.mjs
// Injeção manual de comandos: criar um .json em ./inbox com
//   { "channel": "A", "message": { "kind": "writeSource", "path": "X", "source": "..." } }

import { WebSocketServer } from "ws";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHANNELS = { A: 34901, B: 34902 };
const INBOX_DIR = path.join(__dirname, "inbox");
const LOG_FILE = path.join(__dirname, "session.log");

const sockets = {}; // "A" | "B" -> ws
const waiters = []; // { channel, predicate, resolve, timer }
const results = [];
let requestCounter = 0;
let scenariosStarted = false;

fs.mkdirSync(INBOX_DIR, { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(...args) {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${args.join(" ")}`;
  console.log(line);
  logStream.write(line + "\n");
}

function send(channel, message) {
  const socket = sockets[channel];
  if (!socket || socket.readyState !== 1) {
    log(`[${channel} →] DESCARTADO (canal desconectado):`, JSON.stringify(message));
    return false;
  }
  socket.send(JSON.stringify(message));
  log(`[${channel} →]`, JSON.stringify(message).slice(0, 300));
  return true;
}

function waitFor(channel, description, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const waiter = { channel, predicate, resolve, timer: null };
    waiter.timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error(`timeout (${timeoutMs}ms) esperando ${description} no canal ${channel}`));
    }, timeoutMs);
    waiters.push(waiter);
  });
}

function dispatch(channel, message) {
  for (let i = waiters.length - 1; i >= 0; i--) {
    const waiter = waiters[i];
    if (waiter.channel === channel && waiter.predicate(message)) {
      waiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }
}

function request(channel, message, timeoutMs = 10000) {
  const requestId = `req-${++requestCounter}`;
  const promise = waitFor(channel, `resposta de ${message.kind} (${requestId})`, (m) => m.requestId === requestId, timeoutMs);
  if (!send(channel, { ...message, requestId })) {
    return Promise.reject(new Error(`canal ${channel} desconectado`));
  }
  return promise;
}

// ------------------------------------------------------------- servidores

for (const [channel, port] of Object.entries(CHANNELS)) {
  const server = new WebSocketServer({ host: "127.0.0.1", port });
  server.on("listening", () => log(`canal ${channel} ouvindo em ws://127.0.0.1:${port}`));
  server.on("connection", (socket) => {
    log(`canal ${channel}: Studio conectou`);
    sockets[channel] = socket;
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        log(`[${channel} ←] NÃO-JSON:`, data.toString().slice(0, 200));
        return;
      }
      log(`[${channel} ←]`, JSON.stringify(message).slice(0, 300));
      dispatch(channel, message);
      if (message.kind === "hello") {
        maybeRunScenarios();
      }
    });
    socket.on("close", () => {
      log(`canal ${channel}: desconectou`);
      if (sockets[channel] === socket) {
        delete sockets[channel];
      }
    });
    socket.on("error", (error) => log(`canal ${channel}: erro ws: ${error.message}`));
  });
  server.on("error", (error) => log(`canal ${channel}: erro do servidor: ${error.message}`));
}

// --------------------------------------------------------------- cenários

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
}

async function crossWrite(from, to, scriptName) {
  const content = `-- escrito via canal ${from} em ${new Date().toISOString()}\nreturn "${scriptName}"\n`;
  const start = Date.now();
  try {
    const arrival = waitFor(
      to,
      `sourceChanged de '${scriptName}'`,
      (m) => m.kind === "sourceChanged" && m.path === scriptName && m.source === content,
      15000
    );
    const ack = await request(from, { kind: "writeSource", path: scriptName, source: content });
    if (!ack.ok) {
      throw new Error(`writeAck falhou: ${ack.error}`);
    }
    await arrival;
    record(`pipeline ${from} → Studio → ${to} ('${scriptName}')`, true, `${Date.now() - start}ms, api=${ack.api}`);
  } catch (error) {
    record(`pipeline ${from} → Studio → ${to} ('${scriptName}')`, false, error.message);
  }
}

async function runScenarios() {
  // 1. RTT de ping/pong por canal
  for (const channel of ["A", "B"]) {
    const start = Date.now();
    try {
      await request(channel, { kind: "ping" });
      record(`ping/pong ${channel}`, true, `${Date.now() - start}ms`);
    } catch (error) {
      record(`ping/pong ${channel}`, false, error.message);
    }
  }

  // 2/3. escrita cruzada nos dois sentidos
  await crossWrite("A", "B", "FromA");
  await crossWrite("B", "A", "FromB");

  // 4. escrita concorrente no MESMO script (informativo: quem vence?)
  try {
    const sourceA = `-- concorrente A ${Date.now()}\nreturn "A"\n`;
    const sourceB = `-- concorrente B ${Date.now()}\nreturn "B"\n`;
    await Promise.allSettled([
      request("A", { kind: "writeSource", path: "Contested", source: sourceA }),
      request("B", { kind: "writeSource", path: "Contested", source: sourceB }),
    ]);
    await sleep(2000);
    const final = await request("A", { kind: "readSource", path: "Contested" });
    const winner = final.source === sourceA ? "A" : final.source === sourceB ? "B" : "conteúdo inesperado";
    record("escrita concorrente no mesmo script (informativo)", true, `estado final: venceu ${winner}`);
  } catch (error) {
    record("escrita concorrente no mesmo script (informativo)", false, error.message);
  }

  // 5. inventário
  try {
    const list = await request("A", { kind: "listScripts" });
    record("listScripts", true, `${(list.paths || []).length} script(s): ${(list.paths || []).join(", ")}`);
  } catch (error) {
    record("listScripts", false, error.message);
  }
}

function printReport() {
  log("=== RELATÓRIO M0.5 ===");
  for (const r of results) {
    log(`${r.ok ? "PASS" : "FAIL"} — ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  log(`Total: ${results.length} cenário(s), ${failed} falha(s).`);
  log("Modo observação ativo: edições manuais em ServerScriptService.SyncTeam_Lab aparecem aqui como sourceChanged origin=studio.");
  log(`Para injetar comandos: crie um .json em ${INBOX_DIR}`);
}

async function maybeRunScenarios() {
  if (scenariosStarted || !sockets.A || !sockets.B) {
    return;
  }
  scenariosStarted = true;
  clearInterval(waitLogger);
  log("=== Canais A e B conectados; cenários começam em 2s ===");
  await sleep(2000);
  try {
    await runScenarios();
  } catch (error) {
    log("Cenários abortados:", error.message);
  }
  printReport();
}

// ------------------------------------------------- inbox (comandos ad hoc)

fs.watch(INBOX_DIR, (_eventType, filename) => {
  if (!filename || !filename.endsWith(".json")) {
    return;
  }
  const filePath = path.join(INBOX_DIR, filename);
  setTimeout(() => {
    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      return; // arquivo já processado/removido
    }
    try {
      const { channel, message } = JSON.parse(content);
      if (channel && message) {
        log(`inbox: enviando ${filename} para o canal ${channel}`);
        send(channel, { requestId: `inbox-${Date.now()}`, ...message });
      } else {
        log(`inbox: ${filename} sem 'channel'/'message'; ignorado`);
      }
      fs.unlinkSync(filePath);
    } catch (error) {
      log(`inbox: arquivo inválido ${filename}: ${error.message}`);
    }
  }, 100);
});

const waitLogger = setInterval(() => {
  if (!scenariosStarted) {
    log(`aguardando o Studio conectar... (A=${sockets.A ? "ok" : "—"}, B=${sockets.B ? "ok" : "—"}) — clique 'Lab: Conectar' no Studio`);
  }
}, 15000);

log("Harness M0.5 iniciado.");
