// SyncTeam — Spike M0.5: ponte interativa (não são cenários automáticos).
//
// Diferente de server.mjs (cenários fake FromA/FromB/Contested — NÃO MEXER
// nele, já validado), este arquivo é uma ponte VIVA para teste manual com
// dois "devs" de verdade:
//
//   canal A (porta 34901) <-> vscode-bridge/workspace-a/  (usuário, VS Code real)
//   canal B (porta 34902) <-> vscode-bridge/workspace-b/  (IA, "segundo dev")
//
// O plugin SyncTeamLab.lua (já instalado, sem alterações necessárias) conecta
// às duas portas e faz broadcast de sourceChanged/scriptAdded para AMBOS os
// canais conectados, e responde ping/writeSource/readSource/listScripts.
//
// Fluxo:
//   1. Ao conectar (hello), sincroniza o estado atual do sandbox do Studio
//      para as DUAS pastas locais (listScripts -> readSource por script).
//   2. Edição local (fs.watch em qualquer das pastas) -> writeSource no canal
//      correspondente.
//   3. sourceChanged do Studio (chega em QUALQUER canal, pois o plugin faz
//      broadcast pros dois) -> escreve o arquivo nas DUAS pastas, convergindo
//      workspace-a e workspace-b sempre para o mesmo conteúdo.
//
// Nomenclatura em disco: usa a convenção real do Rojo (Nome.luau,
// Nome.server.luau, Nome.client.luau, Pasta/init.*.luau), calculada por
// `./rojo-path-mapping.mjs` (módulo puro e testado — ver
// rojo-path-mapping.test.mjs) a partir do que a ponte sabe sobre cada script
// (`knownClasses`: path -> className). Isso substitui o esquema anterior
// ("<Nome>.lua" plano com className adivinhada pelo nome do arquivo).
//
// Dedupe: um cache de conteúdo por (pasta, diskPath) evita eco infinito — uma
// escrita feita pela própria ponte (local->Studio ou Studio->local, inclusive
// mover um arquivo de lugar quando o layout muda) atualiza o cache ANTES de
// tocar o disco, então quando o fs.watch disparar por causa dessa mesma
// escrita, o conteúdo lido bate com o cache e é ignorado. Não é necessário
// rastrear "quem mandou" a mudança.
//
// Uso: mesma pasta do server.mjs (já tem `ws` instalado via package.json).
//   node bridge-server.mjs
//
// Sem cenários automáticos, sem inbox — é só a ponte rodando, aguardando o
// Studio conectar e os dois lados (workspace-a, workspace-b) serem editados.

import { WebSocketServer } from "ws";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeLayout, parseDiskPath } from "./rojo-path-mapping.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHANNELS = { A: 34901, B: 34902 };
const CHANNEL_BY_FOLDER = { a: "A", b: "B" };
const FOLDER_KEYS = ["a", "b"];
const DEBOUNCE_MS = 150;
const REQUEST_TIMEOUT_MS = 10000;

const BRIDGE_ROOT = path.join(__dirname, "..", "vscode-bridge");
const FOLDERS = {
  a: path.join(BRIDGE_ROOT, "workspace-a"),
  b: path.join(BRIDGE_ROOT, "workspace-b"),
};
const LOG_FILE = path.join(__dirname, "bridge-session.log");

for (const dir of Object.values(FOLDERS)) {
  fs.mkdirSync(dir, { recursive: true });
}

const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function log(...args) {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${args.join(" ")}`;
  console.log(line);
  logStream.write(line + "\n");
}

// ------------------------------------------------------------ estado geral

const sockets = {}; // "A" | "B" -> ws
const pending = new Map(); // requestId -> { resolve, reject, timer }
const debounceTimers = new Map(); // "a:rel/path.luau" -> Timeout
let requestCounter = 0;

// contentCache: "a:disk/path.luau" (minúsculo) -> último conteúdo escrito ou
// visto naquele arquivo, para dedupe de eco (mesmo padrão de sempre, agora
// chaveado pelo diskPath calculado pelo mapeador em vez do path "cru").
const contentCache = new Map();

// knownClasses: instancePath (path como o plugin manda, "/" como separador)
// -> className ("Script" | "LocalScript" | "ModuleScript"). É a fonte de
// verdade para computeLayout — sempre que muda de um jeito que pode afetar o
// layout (path novo, ou className mudando — não deveria na prática, mas não
// custa reforçar), recomputeAndApplyLayout roda de novo sobre TODAS as
// entries conhecidas.
const knownClasses = new Map();

// sourceCache: instancePath -> última Source conhecida do Studio (conteúdo
// "autoritativo", independente de qual caminho de disco representa aquele
// instance no momento). Usado para materializar/mover arquivos quando o
// layout muda sem precisar esperar um novo sourceChanged.
const sourceCache = new Map();

// layoutCache: instancePath -> diskPath atualmente materializado em disco
// (nas duas pastas). Comparar contra o diskPath recém-calculado é como
// detectamos promoção arquivo-plano -> pasta/init (ou o inverso).
const layoutCache = new Map();

function contentCacheKey(folderKey, diskPath) {
  // path comparado case-insensitive (Windows/NTFS não distingue caixa;
  // mesma regra usada nas decorações do RojoCoop).
  return `${folderKey}:${diskPath.toLowerCase()}`;
}

function diskPathToLocalPath(folderKey, diskPath) {
  return path.join(FOLDERS[folderKey], ...diskPath.split("/"));
}

// --------------------------------------------------------------- transporte

function send(channel, message) {
  const socket = sockets[channel];
  if (!socket || socket.readyState !== 1) {
    log(`[${channel} →] DESCARTADO (canal desconectado):`, JSON.stringify(message).slice(0, 300));
    return false;
  }
  socket.send(JSON.stringify(message));
  log(`[${channel} →]`, JSON.stringify(message).slice(0, 300));
  return true;
}

function request(channel, message, timeoutMs = REQUEST_TIMEOUT_MS) {
  const requestId = message.requestId || `bridge-${++requestCounter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`timeout (${timeoutMs}ms) esperando resposta de '${message.kind}' (${requestId}) no canal ${channel}`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    const sent = send(channel, { ...message, requestId });
    if (!sent) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(new Error(`canal ${channel} desconectado`));
    }
  });
}

function resolvePending(message) {
  if (!message.requestId) {
    return false;
  }
  const waiter = pending.get(message.requestId);
  if (!waiter) {
    return false;
  }
  pending.delete(message.requestId);
  clearTimeout(waiter.timer);
  waiter.resolve(message);
  return true;
}

// --------------------------------------------------------- layout (Rojo) --
//
// Tudo que decide COMO NOMEAR arquivos vive em rojo-path-mapping.mjs (módulo
// puro e testado). Aqui só orquestramos: recomputar o layout quando
// knownClasses muda, e aplicar as diferenças (arquivo novo vs. arquivo que
// precisa mudar de lugar) nas duas pastas.

// Remove diretórios vazios subindo a partir de `startDir` até (sem incluir)
// a raiz da pasta do workspace — usado depois de mover um arquivo para fora
// de uma pasta que só existia por causa dele (ex.: demoção pasta -> arquivo
// plano). Nunca remove a própria raiz do workspace, mesmo que fique vazia.
function removeEmptyDirsUpward(folderKey, startDir) {
  const root = path.resolve(FOLDERS[folderKey]);
  let dir = path.resolve(startDir);
  while (true) {
    if (dir.toLowerCase() === root.toLowerCase()) {
      break;
    }
    const rel = path.relative(root, dir);
    if (rel === "" || rel.startsWith("..")) {
      break; // fora da árvore do workspace — nunca deveria acontecer, mas por segurança
    }
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      break;
    }
    if (entries.length > 0) {
      break;
    }
    try {
      fs.rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

// Escreve `content` em `diskPath` nas DUAS pastas, com o mesmo dedupe por
// cache de sempre (ver comentário de topo do arquivo).
function writeInstanceContentToBothFolders(instancePath, diskPath, content, reason) {
  for (const folderKey of FOLDER_KEYS) {
    const key = contentCacheKey(folderKey, diskPath);
    if (contentCache.get(key) === content) {
      continue;
    }
    const isNew = !contentCache.has(key);
    contentCache.set(key, content);
    const filePath = diskPathToLocalPath(folderKey, diskPath);
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, "utf8");
      log(`[Studio → local] workspace-${folderKey}: '${diskPath}' (${instancePath}) ${isNew ? "criado" : "atualizado"} (${reason})`);
    } catch (error) {
      log(`[Studio → local] ERRO escrevendo workspace-${folderKey}/${diskPath}: ${error.message}`);
    }
  }
}

// Promove/move um instance de `oldDiskPath` para `newDiskPath` nas duas
// pastas: lê o conteúdo do arquivo antigo (fallback: sourceCache, se o
// arquivo antigo ainda não existia por algum motivo), escreve no novo
// caminho, remove o antigo e o diretório se ficou vazio. Atualiza o
// contentCache para o novo diskPath e limpa a entrada antiga ANTES de tocar
// o disco, para o fs.watch reagindo a essa própria remoção/criação não gerar
// writeSource espúrio de volta ao Studio.
function movePathOnBothFolders(oldDiskPath, newDiskPath, instancePath, reason) {
  for (const folderKey of FOLDER_KEYS) {
    const oldFilePath = diskPathToLocalPath(folderKey, oldDiskPath);
    const newFilePath = diskPathToLocalPath(folderKey, newDiskPath);
    const oldKey = contentCacheKey(folderKey, oldDiskPath);
    const newKey = contentCacheKey(folderKey, newDiskPath);

    let content = null;
    try {
      content = fs.readFileSync(oldFilePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        log(`layout: workspace-${folderKey} erro lendo '${oldDiskPath}' para mover: ${error.message}`);
      }
    }
    if (content === null && sourceCache.has(instancePath)) {
      content = sourceCache.get(instancePath);
    }

    contentCache.delete(oldKey);
    if (content === null) {
      log(`layout: workspace-${folderKey} '${oldDiskPath}' -> '${newDiskPath}': nada para mover (arquivo antigo ausente e conteúdo ainda desconhecido)`);
      continue;
    }
    contentCache.set(newKey, content);

    try {
      fs.mkdirSync(path.dirname(newFilePath), { recursive: true });
      fs.writeFileSync(newFilePath, content, "utf8");
    } catch (error) {
      log(`layout: workspace-${folderKey} ERRO escrevendo '${newDiskPath}' durante promoção: ${error.message}`);
      continue;
    }
    try {
      fs.unlinkSync(oldFilePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        log(`layout: workspace-${folderKey} ERRO removendo '${oldDiskPath}' antigo após promoção: ${error.message}`);
      }
    }
    removeEmptyDirsUpward(folderKey, path.dirname(oldFilePath));
    log(`layout: workspace-${folderKey} '${oldDiskPath}' promovido para '${newDiskPath}' (${reason})`);
  }
}

// Recomputa o layout Rojo sobre TODAS as entries conhecidas (knownClasses) e
// aplica qualquer diferença em relação ao que já está materializado
// (layoutCache) nas duas pastas: path novo -> cria (se já tiver conteúdo
// conhecido); diskPath mudou -> move. Chamado sempre que knownClasses muda de
// um jeito que pode afetar o layout (novo path, ou className mudando).
function recomputeAndApplyLayout(reason) {
  const entries = Array.from(knownClasses, ([instancePath, className]) => ({ path: instancePath, className }));
  let layout;
  try {
    layout = computeLayout(entries);
  } catch (error) {
    // Colisão de diskPath ou className desconhecida: estado inconsistente,
    // mas não é motivo para derrubar a ponte — loga bem alto e tenta de novo
    // no próximo evento que mudar knownClasses.
    log(`layout: ERRO recomputando layout (${reason}): ${error.message}`);
    return;
  }
  for (const { instancePath, diskPath } of layout) {
    const previousDiskPath = layoutCache.get(instancePath);
    if (previousDiskPath === undefined) {
      layoutCache.set(instancePath, diskPath);
      if (sourceCache.has(instancePath)) {
        writeInstanceContentToBothFolders(instancePath, diskPath, sourceCache.get(instancePath), `novo path (${reason})`);
      }
      continue;
    }
    if (previousDiskPath === diskPath) {
      continue;
    }
    movePathOnBothFolders(previousDiskPath, diskPath, instancePath, reason);
    layoutCache.set(instancePath, diskPath);
  }
}

// -------------------------------------------------- Studio -> arquivo local

// Registra `content` como a Source conhecida de `instancePath` e materializa
// nas duas pastas, no diskPath atual (calculado por recomputeAndApplyLayout).
// Se ainda não sabemos o diskPath (className chegou depois do conteúdo, ou
// nunca chegou), só guarda em sourceCache — recomputeAndApplyLayout escreve
// assim que o layout existir.
function applyStudioContent(instancePath, content, reason) {
  sourceCache.set(instancePath, content);
  let diskPath = layoutCache.get(instancePath);
  if (diskPath === undefined && knownClasses.has(instancePath)) {
    recomputeAndApplyLayout(`layout ausente para '${instancePath}' (${reason})`);
    diskPath = layoutCache.get(instancePath);
  }
  if (diskPath === undefined) {
    log(`Studio → local: '${instancePath}' com conteúdo em cache, mas className ainda desconhecida (aguardando scriptAdded/listScripts) — nada escrito ainda (${reason})`);
    return;
  }
  writeInstanceContentToBothFolders(instancePath, diskPath, content, reason);
}

async function runInitialSync(channel) {
  log(`canal ${channel}: sincronização inicial começando (listScripts)`);
  let list;
  try {
    list = await request(channel, { kind: "listScripts" });
  } catch (error) {
    log(`canal ${channel}: listScripts falhou: ${error.message}`);
    return;
  }
  const paths = list.paths || [];
  log(`canal ${channel}: ${paths.length} script(s) no sandbox: ${paths.join(", ") || "(vazio)"}`);

  // Campo `scripts: [{path, className}]` pode não existir ainda (outro
  // processo está adicionando ao plugin) — não travar a sincronização
  // inicial esperando por ele. Fallback: assume className="Script" a partir
  // de `paths`; corrigido pelos eventos scriptAdded/sourceChanged reais, que
  // sempre trazem className.
  if (Array.isArray(list.scripts) && list.scripts.length > 0) {
    for (const item of list.scripts) {
      if (item && typeof item.path === "string" && typeof item.className === "string") {
        knownClasses.set(item.path, item.className);
      }
    }
    log(`canal ${channel}: className de cada script obtida via campo 'scripts' da resposta (${list.scripts.length} entrada(s))`);
  } else if (paths.length > 0) {
    log(`canal ${channel}: resposta de listScripts sem campo 'scripts' (versão do plugin sem esse campo ainda?) — assumindo className='Script' para popular a sincronização inicial`);
    for (const scriptPath of paths) {
      if (!knownClasses.has(scriptPath)) {
        knownClasses.set(scriptPath, "Script");
      }
    }
  }
  recomputeAndApplyLayout(`listScripts canal ${channel}`);

  for (const scriptPath of paths) {
    try {
      const response = await request(channel, { kind: "readSource", path: scriptPath });
      if (response.ok === false) {
        log(`canal ${channel}: readSource '${scriptPath}' falhou: ${response.error}`);
        continue;
      }
      applyStudioContent(scriptPath, response.source ?? "", `sync inicial via canal ${channel}`);
    } catch (error) {
      log(`canal ${channel}: readSource '${scriptPath}' erro: ${error.message}`);
    }
  }
  log(`canal ${channel}: sincronização inicial concluída`);
}

function handleSourceChanged(channel, message) {
  const scriptPath = message.path;
  if (typeof scriptPath !== "string" || scriptPath === "") {
    log(`canal ${channel}: sourceChanged sem path válido, ignorado`);
    return;
  }
  if (typeof message.className === "string") {
    const previous = knownClasses.get(scriptPath);
    knownClasses.set(scriptPath, message.className);
    if (previous !== message.className) {
      recomputeAndApplyLayout(
        `sourceChanged canal ${channel}: className de '${scriptPath}' ${previous ?? "(novo)"} -> ${message.className}`
      );
    }
  } else {
    log(`canal ${channel}: sourceChanged '${scriptPath}' sem className, mantendo classe já conhecida`);
  }
  applyStudioContent(
    scriptPath,
    message.source ?? "",
    `sourceChanged origin=${message.origin} via=${message.via} canal=${channel}`
  );
}

function handleScriptAdded(channel, message) {
  const scriptPath = message.path;
  const className = message.className;
  if (typeof scriptPath !== "string" || typeof className !== "string") {
    log(`canal ${channel}: scriptAdded com path/className inválido, ignorado: ${JSON.stringify(message).slice(0, 200)}`);
    return;
  }
  const previous = knownClasses.get(scriptPath);
  knownClasses.set(scriptPath, className);
  log(`canal ${channel}: scriptAdded '${scriptPath}' (${className}) — aguardando sourceChanged para materializar o conteúdo local`);
  if (previous !== className) {
    recomputeAndApplyLayout(`scriptAdded canal ${channel}: '${scriptPath}' ${previous ?? "(novo)"} -> ${className}`);
  }
}

// -------------------------------------------------- arquivo local -> Studio

function handleLocalChange(folderKey, normalizedRelPath) {
  const parsed = parseDiskPath(normalizedRelPath);
  if (parsed === null) {
    log(
      `workspace-${folderKey}: '${normalizedRelPath}' não segue a convenção de nomenclatura Rojo ` +
        `(esperado Nome.luau, Nome.server.luau, Nome.client.luau ou Pasta/init.*.luau) — ignorado, nenhum writeSource enviado`
    );
    return;
  }
  const { instancePath, className } = parsed;
  const filePath = diskPathToLocalPath(folderKey, normalizedRelPath);
  const key = contentCacheKey(folderKey, normalizedRelPath);

  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      log(`workspace-${folderKey}: '${normalizedRelPath}' não encontrado (removido?) — remoção de script não é tratada por este bridge`);
      contentCache.delete(key);
    } else {
      log(`workspace-${folderKey}: erro lendo '${normalizedRelPath}': ${error.message}`);
    }
    return;
  }

  if (contentCache.get(key) === content) {
    return; // eco de escrita que a própria ponte já fez (sync inicial, Studio -> local, ou promoção de layout)
  }
  contentCache.set(key, content);
  sourceCache.set(instancePath, content);

  const previousClassName = knownClasses.get(instancePath);
  if (previousClassName !== className) {
    // Não deveria acontecer via edição local pura (a className vem da
    // extensão do arquivo, que o usuário não deveria trocar assim), mas se
    // acontecer, reforça knownClasses e recomputa o layout por segurança.
    knownClasses.set(instancePath, className);
    recomputeAndApplyLayout(
      `workspace-${folderKey}: extensão local de '${instancePath}' implica className ${previousClassName ?? "(desconhecida)"} -> ${className}`
    );
  }

  const channel = CHANNEL_BY_FOLDER[folderKey];
  log(`[local → Studio] workspace-${folderKey}: '${instancePath}' (${className}) mudou, enviando writeSource no canal ${channel}`);
  request(channel, { kind: "writeSource", path: instancePath, source: content, className })
    .then((ack) => {
      if (ack.ok) {
        log(`[local → Studio] canal ${channel}: '${instancePath}' aplicado no Studio (api=${ack.api})`);
      } else {
        log(`[local → Studio] canal ${channel}: FALHA aplicando '${instancePath}': ${ack.error}`);
      }
    })
    .catch((error) => {
      log(`[local → Studio] canal ${channel}: erro enviando '${instancePath}': ${error.message}`);
    });
}

function watchFolder(folderKey) {
  const dir = FOLDERS[folderKey];
  fs.watch(dir, { recursive: true }, (_eventType, filename) => {
    if (!filename) {
      return;
    }
    const normalized = filename.replace(/\\/g, "/");
    const debounceKey = `${folderKey}:${normalized}`;
    const existingTimer = debounceTimers.get(debounceKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    debounceTimers.set(
      debounceKey,
      setTimeout(() => {
        debounceTimers.delete(debounceKey);
        handleLocalChange(folderKey, normalized);
      }, DEBOUNCE_MS)
    );
  });
  log(`observando workspace-${folderKey} (${dir})`);
}

for (const folderKey of FOLDER_KEYS) {
  watchFolder(folderKey);
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
      resolvePending(message);
      switch (message.kind) {
        case "hello":
          log(`canal ${channel}: hello (role=${message.role ?? "?"}, place=${message.placeName ?? "?"}, userId=${message.userId ?? "?"})`);
          runInitialSync(channel).catch((error) => {
            log(`canal ${channel}: sincronização inicial falhou: ${error.message}`);
          });
          break;
        case "sourceChanged":
          handleSourceChanged(channel, message);
          break;
        case "scriptAdded":
          handleScriptAdded(channel, message);
          break;
        case "scriptRemoved":
          log(`canal ${channel}: scriptRemoved '${message.path}' — remoção de arquivo local não tratada (fora de escopo deste bridge)`);
          break;
        default:
          break; // scriptList/sourceContent/pong/writeAck já tratados via resolvePending acima
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

setInterval(() => {
  if (!sockets.A || !sockets.B) {
    log(`aguardando o Studio conectar... (A=${sockets.A ? "ok" : "—"}, B=${sockets.B ? "ok" : "—"}) — clique 'Lab: Conectar' no Studio se necessário`);
  }
}, 15000);

log("Bridge interativo M0.5 iniciado.");
log(`workspace-a: ${FOLDERS.a}`);
log(`workspace-b: ${FOLDERS.b}`);
