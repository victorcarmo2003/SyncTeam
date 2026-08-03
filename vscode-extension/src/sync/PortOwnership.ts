// SyncTeam — "posse de porta" (2026-08-02, docs/DECISIONS.md "3ª rodada" /
// .claude/rules/authority.md, bullet "Matar processo de terceiro"). Amplia o
// fallback automático de porta ocupada (SyncServer.tryListen): quando a porta
// CONFIGURADA está ocupada, em vez de só pular para port+1 (comportamento
// automático de sempre), a extensão pode oferecer ao usuário ENCERRAR o
// processo que a ocupa e reconquistar a porta original.
//
// Módulo puro (sem `vscode`) — três responsabilidades independentes,
// testáveis com fs/child_process/net/ws reais (mesma filosofia do resto de
// `sync/`: sockets/processos de verdade, nunca mockar `ws`):
//
// 1. Lockfile (write/read/removePortLock): grava o PID desta instância a
//    cada bind bem-sucedido do SyncServer, num diretório persistente
//    (ExtensionContext.globalStorageUri em produção). Se um processo morre
//    sem chamar stop() (crash, kill externo, "Reload Window" que não roda
//    deactivate a tempo), o lockfile SOBREVIVE — é o que permite a uma
//    tentativa de bind FUTURA na mesma porta reconhecer "esse processo é uma
//    instância órfã do próprio SyncTeam" com razoável confiança.
// 2. Detecção do processo dono de uma porta ocupada, Windows (netstat+tasklist)
//    e Unix (lsof+ps) — nenhum dos dois documentado em `.claude/research/`
//    porque são utilitários de SO estáveis/básicos (não uma API
//    Roblox/VS Code/Node sujeita a mudança de comportamento); o formato exato
//    do `netstat -ano` foi confirmado por teste real neste projeto (Windows,
//    bind de um `net.Server` de teste + parse da saída) antes de codar.
// 3. Sondagem de handshake (`probePortSignal`): conecta como cliente `ws` DE
//    VERDADE na porta ocupada para diferenciar "sessão SyncTeam já ativa
//    agora" (`"busy"` — SEMPRE oferece o diálogo mesmo assim, com o aviso
//    mais forte de todos, ver correção abaixo) de "só um servidor WebSocket
//    qualquer, sem confirmação de sessão viva" (oferece, com aviso extra) de
//    "nada responde como WebSocket" (oferece normalmente).
//
// **Restrição de segurança central** (docs/DECISIONS.md): matar um processo
// de terceiro NUNCA acontece de forma automática/silenciosa — `host.confirmKill`
// é SEMPRE a única porta pra isso, para TODO sinal de `probePortSignal`, sem
// exceção nenhuma. **Correção 2026-08-02** (pedido explícito do usuário,
// docs/DECISIONS.md "3ª rodada", correção posterior mesma data): uma versão
// anterior desta função tratava `"busy"` (o `SyncServer` remoto respondeu
// `connectionRejected`/`port_in_use`, prova de que já tem um plugin conectado
// agora) como short-circuit para `fallback` IMEDIATO, sem sequer chamar
// `host.confirmKill` — o diálogo nunca aparecia nesse caso. Isso mudou: mesmo
// uma sessão "ativa agora" no registro do servidor remoto NÃO é certeza
// absoluta — pode ser um processo fantasma que travou (ex.: o Studio
// crashou) sem que o servidor tenha detectado a queda ainda, antes do
// timeout de heartbeat. Por isso `"busy"` agora segue o MESMO fluxo de
// identificação de PID (`findOwner`/`readLock`) e SEMPRE mostra o diálogo,
// só que com a mensagem MAIS FORTE de todas — mais forte que a de
// `"respondsWs"` sem identificação. O que continua valendo sem mudança: o
// diálogo nunca dispara enquanto uma tentativa de conexão legítima de OUTRO
// Studio (2ª conta/2º Studio na mesma máquina, `CANDIDATE_PORTS = {1400,1401}`
// em `plugin/src/Config.luau`) estiver em andamento naquela porta — isso é
// uma questão de timing do próprio bind (`SyncServer.tryListen`/
// `onPortOccupied`), não do sinal `"busy"`. Fora disso, "não precisa ser
// perfeito": um processo que responde como servidor WebSocket mas não pôde
// ser identificado como órfão do próprio SyncTeam (via lockfile) é tratado
// como "provavelmente uma sessão viva" — sempre oferecido, com aviso extra
// no texto do diálogo (matar sem confirmação nunca acontece para nenhum
// processo, identificado ou não).

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";
import { WebSocket } from "ws";

// ------------------------------------------------------------------ Lockfile

/** Registro gravado no lockfile a cada bind bem-sucedido do `SyncServer`. */
export interface PortLockInfo {
  /** PID do processo (extension host) que fez o bind com sucesso. */
  pid: number;
  /** Porta REAL em que esse processo ficou ouvindo. */
  port: number;
  /** `Date.now()` no momento do bind — informativo (exibição/debug); não é usado para expirar o lock (a checagem de vivo é sempre por PID, ver `isProcessAlive`). */
  startedAt: number;
}

function lockFilePath(lockDir: string, port: number): string {
  return path.join(lockDir, `port-${port}.json`);
}

/**
 * Grava o lockfile de `port` com `info`. Cria `lockDir` recursivamente se
 * ainda não existir. Sem modo "em memória" de propósito — testar contra um
 * tmpdir real (mesma filosofia de `NodeDiskIO`/`createFileLogger`) pega bug
 * de mkdir/permissão que um fake esconderia.
 */
export function writePortLock(lockDir: string, info: PortLockInfo): void {
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(lockFilePath(lockDir, info.port), JSON.stringify(info), "utf8");
}

/**
 * Lê o lockfile de `port`. `null` para: arquivo ausente, JSON malformado, ou
 * formato inesperado (campo faltando/tipo errado) — nunca lança. Quem chama
 * trata `null` como "nenhuma informação prévia própria conhecida para esta
 * porta" (não necessariamente "nunca rodou aqui" — só "não sabemos").
 */
export function readPortLock(lockDir: string, port: number): PortLockInfo | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockFilePath(lockDir, port), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as PortLockInfo).pid !== "number" ||
      typeof (parsed as PortLockInfo).port !== "number" ||
      typeof (parsed as PortLockInfo).startedAt !== "number"
    ) {
      return null;
    }
    return parsed as PortLockInfo;
  } catch {
    return null;
  }
}

/** Remove o lockfile de `port`, se existir. `ENOENT` é esperado/ok (idempotente); qualquer outro erro é relançado para o chamador decidir (SyncServer loga e segue). */
export function removePortLock(lockDir: string, port: number): void {
  try {
    fs.unlinkSync(lockFilePath(lockDir, port));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * `pid` corresponde a um processo vivo agora, com razoável confiança.
 * `process.kill(pid, 0)` (sinal 0 = só testa existência, nunca mata) não
 * lança se o processo existe, mesmo sem permissão para sinalizá-lo de
 * verdade (`EPERM` — ainda existe, só não temos permissão; conta como
 * "vivo"). `ESRCH` = processo não existe. Comportamento confirmado por teste
 * real neste projeto (Windows: spawn de um processo + checagem antes/depois
 * de `process.kill`) antes de codar — ver `.claude/agent-memory/extension-dev.md`.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ---------------------------------------------------- Detecção do dono da porta

/** PID + nome (melhor esforço, pode ser `null`) do processo identificado como dono de uma porta ocupada. */
export interface PortOwnerProcess {
  pid: number;
  processName: string | null;
}

function execFileAsync(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 3000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Extrai a porta de um endereço `host:porta` — cobre IPv4 (`127.0.0.1:1400`)
 * e IPv6 (`[::]:1400`, `[::1]:1400`) sem precisar diferenciar os dois
 * formatos: a porta nunca contém `:`, então pegar o que vem depois do
 * ÚLTIMO `:` do endereço funciona nos dois casos (procurar a substring
 * `":1400"` ingenuamente casaria erroneamente dentro de `":14000"`).
 */
function extractPortFromAddress(address: string): number | null {
  const idx = address.lastIndexOf(":");
  if (idx === -1) {
    return null;
  }
  const value = Number(address.slice(idx + 1));
  return Number.isInteger(value) ? value : null;
}

/**
 * Windows: `netstat -ano -p TCP` lista uma linha por socket no formato
 * `Proto LocalAddr ForeignAddr State PID` — filtra por LocalAddr cuja porta
 * bate com a pedida E State `LISTENING` (é quem fez bind/listen, não uma
 * conexão de saída qualquer que por acaso usa aquela porta local efêmera).
 * Formato confirmado por teste real neste projeto (bind de um `net.Server`
 * de teste + `netstat -ano` de verdade) antes de codar.
 */
async function findProcessOnPortWindows(port: number): Promise<PortOwnerProcess | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"]));
  } catch {
    return null;
  }
  let pid: number | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== "TCP") {
      continue;
    }
    const localAddr = parts[1];
    const state = parts[3];
    const pidStr = parts[parts.length - 1];
    if (state !== "LISTENING" || extractPortFromAddress(localAddr) !== port) {
      continue;
    }
    const parsedPid = Number(pidStr);
    if (Number.isInteger(parsedPid) && parsedPid > 0) {
      pid = parsedPid;
      break;
    }
  }
  if (pid === null) {
    return null;
  }
  return { pid, processName: await findProcessNameWindows(pid) };
}

async function findProcessNameWindows(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    const trimmed = stdout.trim();
    if (!trimmed.startsWith('"')) {
      return null; // "INFO: No tasks..." — PID não encontrado nesta consulta separada (corrida improvável, mas possível)
    }
    const firstField = trimmed.split(",")[0]?.replace(/^"|"$/g, "");
    return firstField && firstField.length > 0 ? firstField : null;
  } catch {
    return null;
  }
}

/**
 * Unix (Linux/macOS): `lsof -iTCP:<porta> -sTCP:LISTEN -t` devolve só o(s)
 * PID(s) ouvindo (LISTEN) naquela porta, um por linha — pega o primeiro.
 * Nome via `ps -p <pid> -o comm=` (melhor esforço). `lsof`/`ps` são
 * utilitários POSIX padrão estáveis há décadas — não uma API sujeita a
 * pesquisa prévia (`.claude/research/`). Se `lsof` não existir no sistema
 * (`ENOENT`) ou falhar por qualquer motivo, degrada para `null`
 * ("processo não identificado") — nunca lança.
 */
async function findProcessOnPortUnix(port: number): Promise<PortOwnerProcess | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("lsof", [`-iTCP:${port}`, "-sTCP:LISTEN", "-t", "-n", "-P"]));
  } catch {
    return null;
  }
  const firstLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return null;
  }
  const pid = Number(firstLine);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const { stdout: psOut } = await execFileAsync("ps", ["-p", String(pid), "-o", "comm="]);
    const name = psOut.trim();
    return { pid, processName: name.length > 0 ? name : null };
  } catch {
    return { pid, processName: null };
  }
}

/**
 * Identifica (melhor esforço, "razoável confiança" — nunca perfeito, ver
 * docs/DECISIONS.md) o processo OUVINDO em `port` agora, nos dois SOs
 * suportados. `null` se não foi possível determinar (comando ausente, erro,
 * nenhuma linha correspondente) — nunca lança/quebra o fluxo de bind.
 */
export async function findProcessOnPort(port: number): Promise<PortOwnerProcess | null> {
  try {
    return process.platform === "win32" ? await findProcessOnPortWindows(port) : await findProcessOnPortUnix(port);
  } catch {
    return null;
  }
}

// -------------------------------------------------------- Sondagem de handshake

/**
 * `"busy"`: o servidor do outro lado é um `SyncServer` com uma sessão JÁ
 * ATIVA (mandou `connectionRejected`/`port_in_use`) — prova definitiva de
 * conexão legítima em andamento, nunca oferecer matar neste caso.
 * `"respondsWs"`: o upgrade WebSocket teve sucesso mas nenhuma rejeição
 * chegou no prazo — pode ser um SyncTeam ocioso (sem plugin conectado agora)
 * OU qualquer outro servidor WS; ambíguo de propósito (ver heurística em
 * `attemptPortReclaim`). `"silent"`: nada responde como WebSocket (conexão
 * recusada, upgrade falhou, ou nenhuma abertura dentro do prazo).
 */
export type PortProbeSignal = "busy" | "respondsWs" | "silent";

/**
 * Conecta como cliente `ws` DE VERDADE em `ws://127.0.0.1:<port>` só para
 * observar o sinal acima. **Nunca manda `hello`** — de propósito: o
 * `SyncServer` remoto só registra um socket como "cliente conectado"
 * (`this.clients.add`) depois de validar um `hello` (`handleHello`); se a
 * sonda mandasse um, e não houvesse NINGUÉM realmente conectado do outro
 * lado, a PRÓPRIA sonda viraria "o plugin" daquela conexão — disparando
 * `onClientConnected`/notificação visível de "plugin conectado" no VS Code
 * de quem quer que esteja rodando aquele servidor. Ficando muda, a sonda só
 * observa o que o servidor manda por conta própria: a rejeição de 2º cliente
 * (`handleConnection`) é decidida e enviada ANTES de qualquer mensagem
 * nossa, só por causa do timing da conexão TCP — funciona sem precisarmos
 * enviar nada.
 */
export function probePortSignal(port: number, timeoutMs = 500): Promise<PortProbeSignal> {
  return new Promise((resolve) => {
    let settled = false;
    let sawOpen = false;
    let socket: WebSocket;
    const finish = (result: PortProbeSignal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket.terminate();
      } catch {
        // socket pode já estar fechado — ignora.
      }
      resolve(result);
    };
    try {
      socket = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      resolve("silent");
      return;
    }
    const timer = setTimeout(() => finish(sawOpen ? "respondsWs" : "silent"), timeoutMs);
    // Nunca removemos os listeners abaixo (nem em `finish`): `terminate()`
    // chamado enquanto o handshake HTTP de upgrade ainda está pendente (ex.:
    // o outro lado é um `net.Server` puro que nunca responde) pode emitir um
    // 'error' ASSÍNCRONO internamente (abort do request em andamento) DEPOIS
    // que `finish` já resolveu — sem NENHUM listener de 'error' permanecendo
    // conectado, o Node relançaria isso como exceção não tratada do processo.
    // Mantendo o listener conectado, o guard `if (settled) return` no início
    // de `finish` absorve com segurança qualquer disparo tardio.
    socket.on("open", () => {
      sawOpen = true;
    });
    socket.on("message", (data: Buffer | string) => {
      try {
        const message = JSON.parse(data.toString()) as { kind?: unknown; reason?: unknown };
        if (message.kind === "connectionRejected" && message.reason === "port_in_use") {
          finish("busy");
        }
      } catch {
        // não é o formato de mensagem esperado — ignora, aguarda timeout/close.
      }
    });
    socket.on("error", () => finish("silent"));
    socket.on("close", () => finish(sawOpen ? "respondsWs" : "silent"));
  });
}

// -------------------------------------------------------- Decisão orquestrada

/** Resultado da tentativa de posse — consumido pelo hook `SyncServerOptions.onPortOccupied`. */
export interface PortOccupiedDecision {
  /** `"retrySamePort"`: tenta de novo a MESMA porta (processo encerrado com sucesso, ou usuário pediu retry). `"fallback"`: segue o fluxo normal (port+1...). */
  action: "retrySamePort" | "fallback";
  /** Presente só quando `action === "retrySamePort"` E um processo foi de fato identificado e encerrado — para o chamador reportar isso ao usuário. */
  reclaimed?: { pid: number; processName: string | null };
}

/**
 * Ponte com o mundo VS Code para o ÚNICO passo que precisa de UI real
 * (mostrar o diálogo e capturar a escolha do usuário) — o texto já vem
 * pronto (composto por `attemptPortReclaim`, lógica pura/testável), então o
 * host só precisa exibir e devolver a decisão. Mesma filosofia de
 * `SyncControllerHost`: a lógica de decisão nunca importa `vscode`.
 */
export interface PortReclaimHost {
  /** Mostra `message` e resolve `true` só se o usuário confirmar explicitamente encerrar o processo (qualquer outra coisa — recusa, fechar o diálogo — é `false`). */
  confirmKill(message: string): Promise<boolean>;
  /** Mensagem informativa (mesmo canal que os demais logs visíveis já usam). */
  info(message: string): void;
  /** Mensagem de erro/aviso visível. */
  error(message: string): void;
}

export interface AttemptPortReclaimParams {
  /** Porta que o usuário configurou (só para contexto/mensagens — a decisão toda gira em torno de `occupiedPort`). */
  requestedPort: number;
  /** Porta ocupada agora (== `requestedPort`; `SyncServer` só chama este hook para a porta configurada, nunca para as de fallback). */
  occupiedPort: number;
  /** Diretório do lockfile (`ExtensionContext.globalStorageUri` em produção). */
  lockDir: string;
  host: PortReclaimHost;
  /** Injetáveis para teste — cada um tem um default real (produção nunca precisa passar nenhum). */
  probeSignal?: (port: number, timeoutMs?: number) => Promise<PortProbeSignal>;
  findOwner?: (port: number) => Promise<PortOwnerProcess | null>;
  readLock?: (lockDir: string, port: number) => PortLockInfo | null;
  isAlive?: (pid: number) => boolean;
  killProcess?: (pid: number, signal?: NodeJS.Signals) => void;
  isPortFreeCheck?: (port: number) => Promise<boolean>;
  /** Quanto esperar (ms) a porta ficar livre depois de encerrar o processo, antes de desistir e cair no fallback normal. Default 2000ms; a metade desse prazo, se o processo ainda estiver vivo, é escalado de SIGTERM para SIGKILL (só em SOs POSIX — Windows já força término independente do sinal). */
  waitFreeMs?: number;
}

const DEFAULT_WAIT_FREE_MS = 2000;
const WAIT_FREE_POLL_MS = 150;

function defaultKillProcess(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  process.kill(pid, signal);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/**
 * Orquestra a decisão inteira de "posse de porta" para uma porta configurada
 * ocupada — chamado pelo hook `SyncServerOptions.onPortOccupied` (via
 * `extension.ts`). Nunca lança: qualquer falha em qualquer etapa degrada
 * para `{action:"fallback"}`, deixando o fallback automático de sempre
 * (`SyncServer`/port+1...) resolver.
 *
 * Heurística de segurança (docs/DECISIONS.md, "não precisa ser perfeito, mas
 * documentada"). **Correção 2026-08-02** (pedido explícito do usuário): o
 * sinal `probeSignal === "busy"` deixou de ser short-circuit para
 * `fallback` — mesmo uma sessão "ativa agora" pode na verdade ser um
 * processo fantasma que travou sem o servidor remoto ter notado ainda
 * (heartbeat não estourou). `"busy"` agora participa do MESMO fluxo de
 * identificação/confirmação que os outros sinais, só que com a mensagem
 * mais forte de todas:
 * 1. `probeSignal === "busy"` (sessão SyncTeam com plugin conectado AGORA no
 *    registro do servidor remoto) → identifica o processo normalmente
 *    (`findOwner`/`readLock`, igual aos outros sinais) e SEMPRE mostra o
 *    diálogo, com a mensagem MAIS FORTE de todas (mais forte que a de
 *    `"respondsWs"` no item 3): deixa claro que é muito provável ser um
 *    colega trabalhando de verdade agora, que matar pode causar perda de
 *    trabalho não salvo de outra pessoa, mas que esse sinal não é certeza
 *    absoluta. Prevalece sobre a mensagem de "zumbi identificado" (item 2)
 *    mesmo se o lockfile também identificar o processo — a evidência de
 *    sessão ativa agora pesa mais que o lockfile.
 * 2. Processo identificado (via lockfile vivo, cujo PID bate com quem o SO
 *    reporta ouvindo na porta — ou lockfile sozinho se o SO não conseguiu
 *    detectar nada) E sinal DIFERENTE de `"busy"` → sugestão DEFAULT "zumbi
 *    do próprio SyncTeam", diálogo com o tom mais ameno (mesmo assim SEMPRE
 *    com confirmação explícita).
 * 3. `probeSignal === "respondsWs"` sem identificação por lockfile (fala
 *    WebSocket, mas não é possível confirmar que é órfão) → tratado como
 *    "provavelmente uma sessão viva": ainda oferece matar, mas com aviso
 *    extra explícito no texto do diálogo.
 * 4. Nem lockfile nem SO conseguem identificar NENHUM pid → nada para
 *    oferecer; `fallback` sem nunca mostrar diálogo (vale também para
 *    `"busy"` — sem PID identificado não há processo concreto para
 *    oferecer matar).
 * 5. Caso contrário (processo detectado pelo SO, mas nem lockfile nem
 *    `respondsWs`/`busy` o relacionam ao SyncTeam) → oferece matar um
 *    processo "desconhecido", sempre com confirmação explícita e PID/nome
 *    visíveis.
 */
export async function attemptPortReclaim(params: AttemptPortReclaimParams): Promise<PortOccupiedDecision> {
  const {
    occupiedPort,
    lockDir,
    host,
    probeSignal = probePortSignal,
    findOwner = findProcessOnPort,
    readLock = readPortLock,
    isAlive = isProcessAlive,
    killProcess = defaultKillProcess,
    isPortFreeCheck = isPortFree,
    waitFreeMs = DEFAULT_WAIT_FREE_MS,
  } = params;

  const signal = await probeSignal(occupiedPort).catch((): PortProbeSignal => "silent");

  // Correção 2026-08-02: `"busy"` NÃO é mais short-circuit para fallback —
  // continua o fluxo normal de identificação/confirmação abaixo, igual aos
  // outros sinais (ver docstring da função e comentário no topo do arquivo).
  const [detected, lock] = await Promise.all([
    findOwner(occupiedPort).catch(() => null),
    Promise.resolve(readLock(lockDir, occupiedPort)),
  ]);

  const isOwnOrphan = lock !== null && isAlive(lock.pid) && (detected === null || detected.pid === lock.pid);
  const pid = detected?.pid ?? (isOwnOrphan ? (lock as PortLockInfo).pid : null);

  if (pid === null) {
    host.info(
      signal === "busy"
        ? `porta ${occupiedPort} está ocupada por uma sessão SyncTeam que parece ATIVA agora, mas não foi possível ` +
          "identificar o processo responsável — seguindo com o fallback automático de porta."
        : `porta ${occupiedPort} ocupada, mas não foi possível identificar o processo responsável — seguindo com o ` +
          "fallback automático de porta.",
    );
    return { action: "fallback" };
  }

  const processName = detected?.processName ?? null;
  const label = processName ? `${processName} (PID ${pid})` : `PID ${pid}`;

  // Ordem de precedência deliberada: "busy" (sessão ativa AGORA, segundo o
  // próprio registro do servidor remoto) é checado ANTES de `isOwnOrphan` —
  // a evidência de sessão ativa agora pesa mais que o lockfile, mesmo que os
  // dois apontem para o mesmo PID (ver docstring acima).
  let message: string;
  if (signal === "busy") {
    message =
      `SyncTeam: a porta ${occupiedPort} está ocupada por ${label}, com uma sessão SyncTeam CONECTADA AGORA ` +
      "(o plugin do Studio já está conectado nela neste exato momento). É MUITO PROVÁVEL que seja um colega de " +
      "verdade trabalhando — encerrar esse processo pode causar PERDA DE TRABALHO NÃO SALVO de outra pessoa. " +
      "Mesmo assim, esse sinal não é uma certeza absoluta: às vezes o processo trava (ex.: o Studio fecha/crasha) " +
      "sem que o servidor perceba a queda a tempo, antes do timeout de heartbeat — nesse caso a sessão \"ativa\" é " +
      "só um fantasma. Tem certeza que deseja encerrar esse processo mesmo assim?";
  } else if (isOwnOrphan) {
    message =
      `SyncTeam: a porta ${occupiedPort} está ocupada por uma instância anterior do próprio SyncTeam que não ` +
      `encerrou corretamente (${label}). Deseja encerrar esse processo e assumir a porta ${occupiedPort} agora?`;
  } else if (signal === "respondsWs") {
    message =
      `SyncTeam: a porta ${occupiedPort} está ocupada por ${label}, que respondeu como um servidor WebSocket ativo ` +
      "— isso é consistente com uma sessão do SyncTeam de um colega (ex.: segunda conta Roblox na mesma máquina), " +
      "PROVAVELMENTE uma sessão viva, não travada. Encerrar pode derrubar o trabalho de outra pessoa. Tem certeza " +
      "que deseja encerrar mesmo assim?";
  } else {
    message =
      `SyncTeam: a porta ${occupiedPort} está ocupada por ${label}, não identificado como uma instância do ` +
      "SyncTeam. Deseja encerrá-lo à força e assumir a porta? Isso pode afetar outro programa em execução.";
  }

  const confirmed = await host.confirmKill(message).catch(() => false);
  if (!confirmed) {
    host.info(
      `usuário optou por não encerrar o processo na porta ${occupiedPort} — seguindo com o fallback automático de porta.`,
    );
    return { action: "fallback" };
  }

  try {
    killProcess(pid);
  } catch (error) {
    host.error(
      `falha ao encerrar o processo PID ${pid}: ${(error as Error).message} — seguindo com o fallback automático de porta.`,
    );
    return { action: "fallback" };
  }

  const deadline = Date.now() + waitFreeMs;
  let escalated = false;
  while (Date.now() < deadline) {
    if (await isPortFreeCheck(occupiedPort)) {
      return { action: "retrySamePort", reclaimed: { pid, processName } };
    }
    if (!escalated && Date.now() > deadline - waitFreeMs / 2 && isAlive(pid)) {
      escalated = true;
      try {
        killProcess(pid, "SIGKILL");
      } catch {
        // melhor esforço de escalada — a próxima checagem de isPortFreeCheck decide o resultado final de qualquer forma.
      }
    }
    await sleep(WAIT_FREE_POLL_MS);
  }

  host.error(
    `processo PID ${pid} encerrado, mas a porta ${occupiedPort} não foi liberada a tempo (${waitFreeMs}ms) — ` +
      "seguindo com o fallback automático de porta.",
  );
  return { action: "fallback" };
}
