// SyncTeam — ponto de ativação da extensão VS Code (M1: 1 dev, sem
// coordenação de time). Acha o `default.project.json` do workspace, lê os
// pontos de montagem, sobe o servidor WebSocket local (o plugin Studio
// conecta como cliente) e liga um FileSystemWatcher para propagar edições
// locais ao Studio.
//
// Regra de .claude/rules/typescript.md: escrita no workspace do usuário
// passa por vscode.workspace.fs (VscodeDiskIO), não node:fs direto — só a
// camada de LÓGICA (mapping/, SyncBridge) é testável com node:fs puro.

import * as vscode from "vscode";
import * as path from "node:path";
import { SyncServer } from "./sync/SyncServer.js";
import { SyncTeamService } from "./sync/SyncTeamService.js";
import { VscodeDiskIO } from "./sync/VscodeDiskIO.js";
import { attemptPortReclaim } from "./sync/PortOwnership.js";
import { parseMountPoints, type MountPoint } from "./mapping/projectMapping.js";
import { createOutputChannelLogger } from "./util/vscodeLogger.js";
import type { Logger } from "./util/logger.js";
import { PresencePublisher } from "./presence/PresencePublisher.js";
import { PresenceTracker } from "./presence/PresenceTracker.js";
import { FilePresenceDecorations } from "./ui/FilePresenceDecorations.js";
import { RemoteCursorDecorations } from "./ui/RemoteCursorDecorations.js";
import { LeaseBorderDecoration } from "./ui/LeaseBorderDecoration.js";
import { SyncTeamStatusBar } from "./ui/StatusBarItem.js";
import { SyncController, type ConnectionState, type SyncControllerHost, type StartServiceResult } from "./SyncController.js";
import { validatePortInput } from "./util/port.js";

// Reexportado para a status bar (ui-dev) tipar o retorno de getConnectionState.
export type { ConnectionState } from "./SyncController.js";

const DEFAULT_PORT = 1400;
const WATCH_DEBOUNCE_MS = 150;
// M4: mesma constante de debounce do watcher de arquivo — publicar
// cursor/seleção a cada tecla/movimento inundaria o canal sem necessidade
// (ver .claude/agent-memory/ui-dev.md para o raciocínio completo).
const PRESENCE_DEBOUNCE_MS = WATCH_DEBOUNCE_MS;
// "Handoff quase-instantâneo de lease" (2026-08-02, docs/DECISIONS.md "8ª
// rodada"): mesma ordem de grandeza de WATCH_DEBOUNCE_MS, calibrada para
// ficar confortavelmente abaixo do novo STALE_AFTER_SECONDS configurável do
// lado Luau (~2-3s) e do tick de checagem de staleness lá (agora 0.5s) — ver
// scheduleBufferPulse abaixo para o porquê de ser um THROTTLE, não um
// debounce como os dois acima.
const BUFFER_PULSE_THROTTLE_MS = WATCH_DEBOUNCE_MS;
// M4: rede de segurança de staleness do PresenceTracker é por-entrada (ver
// PresenceTracker.expireStale); isso só define de quanto em quanto tempo a
// varredura roda.
const PRESENCE_STALE_CHECK_INTERVAL_MS = 5000;

let outputChannel: vscode.OutputChannel | undefined;
let service: SyncTeamService | undefined;
let fileWatcher: vscode.FileSystemWatcher | undefined;
// Controlador de ciclo de vida (start/stop/restart/setPort) + estado observável
// para a status bar (ui-dev). Criado uma vez em activate(); as funções
// exportadas getConnectionState/onDidChangeConnectionState delegam a ele.
let controller: SyncController | undefined;
// M4: raiz do workspace de sincronização (pasta do default.project.json) —
// hoisted para módulo (era local a startService) porque as funções de
// resolução de presença (resolveUuidForFsPath/resolveFsPathForUuid, usadas
// pelas decorações que vivem por toda a vida da extensão) precisam do valor
// ATUAL a cada chamada, não do valor capturado no momento em que foram
// registradas.
let projectDir: vscode.Uri | undefined;
let presencePublisher: PresencePublisher | undefined;
let presenceDebounceTimer: ReturnType<typeof setTimeout> | undefined;
// "Refresh Sync": guarda contra execuções concorrentes e coletor de conflitos
// do run atual. Enquanto uma reconciliação está rodando, `refreshConflicts`
// aponta para o array que o callback `onSyncConflict` alimenta, para o comando
// resumir todos os conflitos numa única mensagem ao final.
let refreshInProgress = false;
let refreshConflicts: Array<{ diskPath: string; uuid: string }> | null = null;
// M4: instanciado uma vez só, sobrevive a restarts do serviço (diferente de
// `service`) — é o estado que as duas UIs de presença (badge do Explorer e
// cursor no editor) leem a qualquer momento, inclusive entre um restart e o
// próximo `hello` do plugin.
const presenceTracker = new PresenceTracker();
// M3.4: aviso visual de lease alheia — instanciada 1x em activate() (mesmo
// ciclo de vida de filePresenceDecorations/remoteCursorDecorations), mas
// precisa ser module-level porque o callback setOnLeaseChanged é registrado
// dentro de startService() (função top-level, chamada a cada
// start/restart/setPort) e precisa re-renderizar a decoração quando uma
// lease muda.
let leaseBorderDecoration: LeaseBorderDecoration | undefined;
// "Handoff quase-instantâneo de lease": timers de throttle do pulse de buffer
// (ver scheduleBufferPulse), chaveados por relDiskPath. Module-level (não
// hoisted por startService, ao contrário de `debounceTimers` do watcher de
// disco) porque o listener onDidChangeTextDocument é registrado UMA vez em
// activate() — sobrevive a restart do serviço; se um timer disparar depois de
// um restart, `service`/`projectDir` são lidos NA HORA (getter-style), então
// o pior caso é um pulse perdido/ignorado pelo SyncBridge novo (uuid
// desconhecido), nunca um crash.
const bufferPulseTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function findProjectFile(): Promise<vscode.Uri | null> {
  const matches = await vscode.workspace.findFiles("**/default.project.json", "**/node_modules/**", 1);
  return matches.length > 0 ? matches[0] : null;
}

async function readProjectMountPoints(projectFileUri: vscode.Uri, logger: Logger): Promise<MountPoint[] | null> {
  let raw: Uint8Array;
  try {
    raw = await vscode.workspace.fs.readFile(projectFileUri);
  } catch (error) {
    logger.error(`erro lendo '${projectFileUri.fsPath}': ${(error as Error).message}`);
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch (error) {
    logger.error(`'${projectFileUri.fsPath}' não é JSON válido: ${(error as Error).message}`);
    return null;
  }
  try {
    return parseMountPoints(json);
  } catch (error) {
    logger.error(`erro interpretando pontos de montagem de '${projectFileUri.fsPath}': ${(error as Error).message}`);
    return null;
  }
}

function relDiskPathFromUri(projectDir: vscode.Uri, fileUri: vscode.Uri): string {
  const relative = path.relative(projectDir.fsPath, fileUri.fsPath);
  return relative.split(path.sep).join("/");
}

// --------------------------------------------------------------- M4: presença

/**
 * uri (absoluto) -> uuid do script sincronizado, ou null se não houver
 * serviço ativo, o arquivo estiver fora do workspace de sincronização, ou
 * não for um script conhecido. Injetado em FilePresenceDecorations (direção
 * "de onde eu tô, quem mais tá aqui?") e RemoteCursorDecorations (direção
 * "o editor ativo corresponde a qual uuid?").
 */
function resolveUuidForFsPath(fsPath: string): string | null {
  if (!service || !projectDir) {
    return null;
  }
  const relPath = relDiskPathFromUri(projectDir, vscode.Uri.file(fsPath));
  return service.resolveUuidForDiskPath(relPath);
}

/**
 * Direção inversa: uuid -> caminho absoluto em disco, ou null se ainda não
 * materializado/serviço inativo. Usado só por FilePresenceDecorations, para
 * saber qual Uri notificar quando a presença de um uuid muda.
 */
function resolveFsPathForUuid(uuid: string): string | null {
  if (!service || !projectDir) {
    return null;
  }
  const relPath = service.resolveDiskPathForUuid(uuid);
  if (relPath === null) {
    return null;
  }
  return vscode.Uri.joinPath(projectDir, ...relPath.split("/")).fsPath;
}

/** Debounce de ~150ms (PRESENCE_DEBOUNCE_MS) antes de publicar cursor/seleção. */
function schedulePresencePublish(): void {
  if (presenceDebounceTimer) {
    clearTimeout(presenceDebounceTimer);
  }
  presenceDebounceTimer = setTimeout(() => {
    presenceDebounceTimer = undefined;
    publishCurrentPresence();
  }, PRESENCE_DEBOUNCE_MS);
}

/**
 * Monta o payload de `presenceUpdate` a partir do editor ativo e manda pelo
 * `presencePublisher` da conexão atual. `uuid: null` (via `publishClear`)
 * cobre: nenhum serviço ativo, nenhum editor ativo, documento fora do
 * esquema `file` (ex.: aba de configurações/diff), ou arquivo fora de
 * qualquer ponto de montagem/desconhecido.
 */
function publishCurrentPresence(): void {
  if (!presencePublisher) {
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor || !projectDir || editor.document.uri.scheme !== "file") {
    presencePublisher.publishClear();
    return;
  }

  const uuid = resolveUuidForFsPath(editor.document.uri.fsPath);
  if (uuid === null) {
    presencePublisher.publishClear();
    return;
  }

  const selection = editor.selection;
  const hasSelection = !selection.isEmpty;
  presencePublisher.publish({
    uuid,
    cursorLine: selection.active.line,
    cursorColumn: selection.active.character,
    selectionStartLine: hasSelection ? selection.anchor.line : null,
    selectionStartColumn: hasSelection ? selection.anchor.character : null,
  });
}

// ------------------------------------------- handoff quase-instantâneo de lease

/**
 * `onDidChangeTextDocument` (nível de BUFFER — dispara a cada edição no
 * editor, sem exigir save) — 2026-08-02, docs/DECISIONS.md "8ª rodada". O
 * `FileSystemWatcher` de disco (`scheduleNotify`, dentro de `startService`)
 * CONTINUA existindo e intocado: ele é o fallback necessário para mudanças
 * que não passam pelo buffer do VS Code (git checkout, outro processo
 * escrevendo o arquivo). Este listener é uma via EM PARALELO, cujo único
 * objetivo é fazer o `Pulse` do lease do lado Luau
 * (`TeamCreateLease.ensureIntent`) atualizar continuamente ENQUANTO o dono
 * digita, não só quando salva — hoje a detecção de "dono morto" (~8-10s
 * depois de parar de editar) é inteira baseada em save via disco.
 *
 * É THROTTLE, não debounce (ao contrário de `scheduleNotify`/
 * `schedulePresencePublish` acima, que resetam o timer a cada evento e só
 * disparam depois de um período de silêncio): o objetivo aqui é o OPOSTO —
 * mandar o pulse PERIODICAMENTE durante digitação contínua. Um debounce puro
 * nunca dispararia enquanto o usuário não parasse de digitar por
 * BUFFER_PULSE_THROTTLE_MS, o que anularia o propósito da feature. Reusa o
 * mesmo mecanismo (Map<path, Timer> + setTimeout) do `scheduleNotify` acima —
 * só sem o `clearTimeout`/reagendamento a cada evento: se já existe um timer
 * pendente para este path, novos eventos dentro da janela são ignorados (o
 * disparo pendente vai pegar `document.getText()` no MOMENTO em que
 * disparar, ou seja, sempre o conteúdo mais recente — `TextDocument` é o
 * mesmo objeto vivo, não um snapshot).
 *
 * Gate de posse (pedido explícito da tarefa): só age se o arquivo já tiver
 * uuid resolvido (script já sincronizado — a criação de um script novo
 * continua só pelo save, via `handleLocalFileChange`) E a lease for
 * EXPLICITAMENTE minha nesta sessão (`LeaseTracker.isExplicitlyOwnedByMe`,
 * não o `isOwnedByMe` otimista que `LeaseBorderDecoration`/save usam — esse
 * também libera quando a lease ainda não foi arbitrada, o que aqui
 * dispararia pulses cedo demais, antes de eu ser dono de verdade). Reusa
 * `LeaseTracker`/`resolveUuidForFsPath` como única fonte de verdade — nenhum
 * estado de posse novo é criado aqui.
 */
function scheduleBufferPulse(document: vscode.TextDocument): void {
  if (!service || !projectDir || document.uri.scheme !== "file") {
    return;
  }
  const relPath = relDiskPathFromUri(projectDir, document.uri);
  const uuid = service.resolveUuidForDiskPath(relPath);
  if (uuid === null) {
    return; // fora do workspace de sync, ou uuid ainda não resolvido — fluxo de criação via save cuida disso
  }
  const leaseTracker = service.getLeaseTracker();
  if (!leaseTracker?.isExplicitlyOwnedByMe(uuid)) {
    return; // não é minha posse confirmada — nunca dispara para arquivo alheio ou lease ainda não resolvida
  }
  if (bufferPulseTimers.has(relPath)) {
    return; // já agendado dentro da janela de throttle
  }
  bufferPulseTimers.set(
    relPath,
    setTimeout(() => {
      bufferPulseTimers.delete(relPath);
      service?.notifyBufferChange(relPath, document.getText());
    }, BUFFER_PULSE_THROTTLE_MS),
  );
}

/**
 * Ponto de entrada do comando "Refresh Sync" (`syncteam.refreshSync`): dispara
 * a reconciliação bidirecional de 3 vias para todos os arquivos mapeados de uma
 * vez, cobrindo derivas que o watcher / conexão ao vivo tenham perdido (ex.: um
 * processo externo editou/criou um arquivo mapeado enquanto a extensão estava
 * fechada). A lógica vive toda em `SyncBridge.refreshSync`; aqui só tratamos as
 * guardas (serviço ativo, plugin conectado, sem run concorrente) e o feedback
 * ao usuário (resumo de conflitos ou "tudo sincronizado").
 */
async function runRefreshSync(logger: Logger): Promise<void> {
  if (!service) {
    vscode.window.showWarningMessage("SyncTeam: inativo (nenhum default.project.json no workspace).");
    return;
  }
  if (!service.isClientConnected()) {
    vscode.window.showWarningMessage(
      "SyncTeam: nenhum plugin Studio conectado — abra o Studio com o plugin SyncTeam antes de reconciliar.",
    );
    return;
  }
  if (refreshInProgress) {
    vscode.window.showInformationMessage("SyncTeam: reconciliação já em andamento.");
    return;
  }

  refreshInProgress = true;
  const conflicts: Array<{ diskPath: string; uuid: string }> = [];
  refreshConflicts = conflicts;
  logger.info("comando Refresh Sync disparado");
  try {
    await service.refreshSync();
  } catch (error) {
    logger.error(`Refresh Sync falhou: ${(error as Error).message}`);
    vscode.window.showErrorMessage(`SyncTeam: falha na reconciliação — ${(error as Error).message}`);
    return;
  } finally {
    refreshConflicts = null;
    refreshInProgress = false;
  }

  if (conflicts.length > 0) {
    const list = conflicts.map((conflict) => conflict.diskPath).join(", ");
    vscode.window.showWarningMessage(
      `SyncTeam: ${conflicts.length} conflito(s) na reconciliação — disco e Studio divergiram do último ` +
        `sincronizado. Nenhum lado foi sobrescrito; resolva manualmente (abra os dois, decida, salve para forçar a ` +
        `propagação de um lado): ${list}`,
    );
  } else {
    vscode.window.showInformationMessage("SyncTeam: reconciliação concluída — tudo sincronizado.");
  }
}

/**
 * Cria e inicia o serviço na `port` dada. Retorna `{ ok: true }` se um servidor
 * ficou de fato ouvindo; `{ ok: false, reason }` se não havia o que iniciar (sem
 * default.project.json / sem pontos de montagem) ou o bind falhou. Nunca lança —
 * é o `startService` do `SyncControllerHost`, que espera exatamente esse
 * contrato. O `reason` é o que o controlador exibe ao usuário na mensagem de
 * falha (antes só ia para o log e o usuário ficava sem saber o motivo).
 */
async function startService(
  context: vscode.ExtensionContext,
  logger: Logger,
  port: number,
): Promise<StartServiceResult> {
  const projectFileUri = await findProjectFile();
  if (!projectFileUri) {
    logger.info("nenhum default.project.json encontrado no workspace — SyncTeam inativo");
    return { ok: false, reason: "nenhum default.project.json encontrado no workspace" };
  }

  const mountPoints = await readProjectMountPoints(projectFileUri, logger);
  if (!mountPoints || mountPoints.length === 0) {
    logger.error(
      `'${projectFileUri.fsPath}' não tem nenhum ponto de montagem ($path) reconhecível — SyncTeam não tem o que sincronizar`,
    );
    return {
      ok: false,
      reason: `'${path.basename(projectFileUri.fsPath)}' não tem nenhum ponto de montagem ($path) reconhecível`,
    };
  }
  logger.info(`pontos de montagem: ${mountPoints.map((m) => `${m.dataModelPath} -> ${m.diskPath}`).join(", ")}`);

  const dir = vscode.Uri.joinPath(projectFileUri, "..");
  projectDir = dir; // hoisted para módulo — ver comentário na declaração
  const diskIO = new VscodeDiskIO(dir);

  // syncteam.multiSync (default false): permite N Studios conectados na
  // mesma porta/extensão — cenário real: 1 dev com 2 contas Roblox/2 Studios
  // na mesma máquina testando multiplayer. Lido no momento do start (mesmo
  // padrão de syncteam.port/autoStart); mudar a config exige
  // stop+start/restart para ter efeito, igual às demais.
  const multiSync = vscode.workspace.getConfiguration("syncteam").get<boolean>("multiSync", false);
  if (multiSync) {
    logger.info("syncteam.multiSync = true — múltiplos plugins Studio podem conectar nesta porta ao mesmo tempo");
  }

  // "Posse de porta" (2026-08-02, docs/DECISIONS.md 3ª rodada,
  // .claude/rules/authority.md "Matar processo de terceiro"): quando a porta
  // CONFIGURADA está ocupada, oferece ao usuário encerrar o processo que a
  // ocupa (com confirmação explícita SEMPRE, PID/nome visíveis) em vez de
  // pular direto para o fallback automático (port+1...) — a decisão real
  // (identificar dono, sondar se é uma sessão SyncTeam já ativa, compor a
  // mensagem) vive em `PortOwnership.ts::attemptPortReclaim` (testável sem
  // `vscode`); aqui só fornecemos o diretório do lockfile persistente
  // (`globalStorageUri`, sobrevive a "Reload Window"/reinstalação) e a ponte
  // com o diálogo real do VS Code.
  const portLockDir = vscode.Uri.joinPath(context.globalStorageUri, "port-locks").fsPath;
  const server = new SyncServer(port, logger, {
    multiSync,
    portLockDir,
    onPortOccupied: (info) =>
      attemptPortReclaim({
        requestedPort: info.requestedPort,
        occupiedPort: info.occupiedPort,
        lockDir: portLockDir,
        host: {
          confirmKill: (message) =>
            Promise.resolve(
              vscode.window.showWarningMessage(message, { modal: true }, "Encerrar processo", "Usar porta alternativa"),
            ).then((choice) => choice === "Encerrar processo"),
          info: (message) => logger.info(message),
          error: (message) => logger.error(message),
        },
      }),
  });
  service = new SyncTeamService(server, mountPoints, diskIO, logger, multiSync);
  presencePublisher = new PresencePublisher(service.getPresenceTransport());

  // Estado de conexão (plugin conectou/desconectou) reemitido para a status
  // bar via SyncController.onDidChangeConnectionState.
  service.setOnConnectionChanged(() => controller?.notifyConnectionChanged());

  // Notificações visíveis de conexão/erro (usuário reportou confusão sobre o
  // status). Mesmo padrão de callback já usado para leaseChanged/writeRejected.
  service.setOnPluginConnected(() => {
    logger.info("plugin do Studio conectado");
    vscode.window.showInformationMessage("SyncTeam: plugin do Studio conectado.");
  });
  service.setOnPluginDisconnected(() => {
    // Só chega aqui em desconexão-surpresa (queda real / timeout de heartbeat),
    // nunca numa parada deliberada do servidor — ver SyncTeamService.
    logger.warn("plugin do Studio desconectou (queda real ou timeout de heartbeat)");
    vscode.window.showWarningMessage("SyncTeam: plugin do Studio desconectou.");
  });
  service.setOnProtocolError((message) => {
    // Antes só ia para o log (SyncServer). Agora vira aviso visível também.
    vscode.window.showErrorMessage(`SyncTeam: ${message}`);
  });

  // "ReSync" (2026-08-02, docs/DECISIONS.md "5ª rodada"): confirmação modal
  // ANTES de apagar qualquer arquivo de Source sincronizado — mesmo padrão
  // já usado para "posse de porta" (`host.confirmKill` acima): a decisão real
  // (o quê apagar, como zerar o estado, como repuxar) vive em
  // `SyncTeamService`/`SyncBridge` (testável sem `vscode`); aqui só ligamos o
  // diálogo real.
  service.setOnConfirmResync((message) =>
    Promise.resolve(vscode.window.showWarningMessage(message, { modal: true }, "Confirmar", "Cancelar")).then(
      (choice) => choice === "Confirmar",
    ),
  );

  // M3.3: configurar callbacks de UI para leaseChanged e writeRejected.
  service.setOnLeaseChanged(({ uuid, ownerClientId, ownerDisplayName }) => {
    if (ownerClientId === null) {
      // Lease foi liberada.
      logger.info(`lease de '${uuid}' foi liberada`);
    } else {
      // Alguém adquiriu ou mantém a lease.
      const owner = ownerDisplayName ?? `cliente ${ownerClientId}`;
      logger.info(`lease de '${uuid}' agora é de ${owner}`);
    }
    // M3.4: re-renderizar o aviso visual (overlay + rótulo) nos editores
    // visíveis — a lease pode ter mudado para o arquivo que o usuário está
    // olhando agora.
    leaseBorderDecoration?.renderAll();
  });

  service.setOnWriteRejected(({ diskPath, error }) => {
    logger.warn(`escrita negada em '${diskPath}': ${error}`);
    vscode.window.showWarningMessage(`SyncTeam: não foi possível editar '${diskPath}' — ${error}`);
  });

  // "Refresh Sync": conflito genuíno detectado na reconciliação sob demanda. O
  // SyncBridge já logou o conflito; aqui só acumulamos para o comando resumir
  // (ou avisamos avulso, como salvaguarda, se vier fora de um run do comando).
  service.setOnSyncConflict(({ diskPath, uuid }) => {
    if (refreshConflicts) {
      refreshConflicts.push({ diskPath, uuid });
    } else {
      vscode.window.showWarningMessage(
        `SyncTeam: conflito em '${diskPath}' — disco e Studio divergiram do último sincronizado; resolva manualmente.`,
      );
    }
  });

  // M4: presença remota (cursores/seleção/badge do Explorer).
  service.setOnPresenceChanged((presence) => {
    presenceTracker.updatePresence(
      presence.clientId,
      presence.displayName,
      presence.uuid,
      presence.cursorLine,
      presence.cursorColumn,
      presence.selectionStartLine,
      presence.selectionStartColumn,
    );
  });
  service.setOnPresenceLeft(({ clientId }) => {
    presenceTracker.removePresence(clientId);
  });
  service.setOnPresenceReset(() => {
    // Canal novo (ou caiu): estado remoto anterior não é mais confiável, E
    // minha própria presença precisa ser reenviada do zero (o novo plugin
    // não tem memória do que já mandamos antes) assim que reconectar.
    presenceTracker.clear();
    presencePublisher?.resetDedupe();
    schedulePresencePublish();
  });

  try {
    await service.start();
  } catch (error) {
    const message = (error as Error).message;
    logger.error(`falha ao iniciar o servidor WebSocket na porta ${port}: ${message}`);
    service = undefined;
    presencePublisher = undefined;
    projectDir = undefined;
    return { ok: false, reason: `erro ao abrir a porta ${port} — ${message}` };
  }

  // Fallback automático de porta ocupada (2026-08-02, .claude/rules/authority.md):
  // se a porta configurada estava ocupada, service.start() já resolveu numa
  // porta alternativa (SyncServer.tryListen) em vez de rejeitar — a porta REAL
  // pode diferir de `port` aqui. Repassamos para o SyncController anunciar
  // claramente e atualizar o estado consultável pela status bar.
  const actualPort = service.getActualPort() ?? port;
  // "Posse de porta": se em vez do fallback acima o usuário optou por
  // encerrar o processo que ocupava a porta CONFIGURADA (ver onPortOccupied
  // acima), service.start() reconquistou a MESMA porta pedida — actualPort
  // já é igual a `port` neste caso, e isto só existe para o SyncController
  // mostrar uma mensagem distinta confirmando a posse tomada.
  const reclaimed = service.getLastReclaimed();

  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, "**/*"));
  fileWatcher = watcher;
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleNotify = (uri: vscode.Uri) => {
    const relPath = relDiskPathFromUri(dir, uri);
    const existing = debounceTimers.get(relPath);
    if (existing) {
      clearTimeout(existing);
    }
    debounceTimers.set(
      relPath,
      setTimeout(() => {
        debounceTimers.delete(relPath);
        service?.notifyLocalFileChange(relPath);
      }, WATCH_DEBOUNCE_MS),
    );
  };
  context.subscriptions.push(
    watcher.onDidChange(scheduleNotify),
    watcher.onDidCreate(scheduleNotify),
    // 2026-07-20: sem isso, uma remoção local (delete de arquivo, ou a
    // metade "delete" de um rename local) nunca chega a
    // SyncBridge.handleLocalFileChange pelo watcher ao vivo — o gap coberto
    // do lado da lógica (readFile null -> deleteScript) ficava morto sem
    // este fio. Mesmo debounce/scheduleNotify de onDidChange/onDidCreate;
    // relDiskPathFromUri é só cálculo de path (sem tocar disco), então
    // funciona igual para uma URI que já não existe mais.
    watcher.onDidDelete(scheduleNotify),
    watcher,
    { dispose: () => {
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
    } },
  );

  logger.info(`SyncTeam ativo — projeto '${projectFileUri.fsPath}', porta ${actualPort}`);
  if (actualPort !== port) {
    return { ok: true, actualPort };
  }
  return reclaimed ? { ok: true, portReclaimed: reclaimed } : { ok: true };
}

/**
 * Para o serviço atual e desmonta watcher/estado de presença. Idempotente
 * (no-op se já estiver parado). Extraído do antigo comando `restart` para ser
 * reusado por stop/restart/setPort (via SyncControllerHost) e por deactivate.
 */
async function stopService(): Promise<void> {
  await service?.stop();
  service = undefined;
  presencePublisher = undefined;
  projectDir = undefined;
  presenceTracker.clear();
  fileWatcher?.dispose();
  fileWatcher = undefined;
  // M3.4: serviço parou — leaseTracker some (getter passa a devolver null);
  // sem isto o aviso visual de uma lease antiga ficaria "pendurado" até a
  // próxima troca de editor ativo.
  leaseBorderDecoration?.renderAll();
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("SyncTeam");
  const logger = createOutputChannelLogger(outputChannel);
  logger.info("extensão SyncTeam ativada");

  context.subscriptions.push(outputChannel);

  // M4: UI de presença — instanciadas uma vez só (sobrevivem a
  // syncteam.restart), lendo `presenceTracker` (também module-level) e
  // resolvendo uuid<->fsPath via `service`/`projectDir` ATUAIS a cada
  // chamada (ver resolveUuidForFsPath/resolveFsPathForUuid acima).
  const filePresenceDecorations = new FilePresenceDecorations(presenceTracker, resolveUuidForFsPath, resolveFsPathForUuid);
  const remoteCursorDecorations = new RemoteCursorDecorations(presenceTracker, resolveUuidForFsPath);
  // M3.4: getter (não `service.getLeaseTracker()` capturado) porque
  // `service` é recriado a cada start/restart — a mesma técnica de
  // resolveUuidForFsPath/resolveFsPathForUuid acima, que leem a variável de
  // módulo `service` no momento da chamada.
  leaseBorderDecoration = new LeaseBorderDecoration(() => service?.getLeaseTracker() ?? null, resolveUuidForFsPath);
  const presenceStaleTimer = setInterval(() => presenceTracker.expireStale(), PRESENCE_STALE_CHECK_INTERVAL_MS);

  context.subscriptions.push(
    filePresenceDecorations,
    remoteCursorDecorations,
    leaseBorderDecoration,
    { dispose: () => clearInterval(presenceStaleTimer) },
    vscode.window.onDidChangeActiveTextEditor(() => schedulePresencePublish()),
    vscode.window.onDidChangeTextEditorSelection(() => schedulePresencePublish()),
    { dispose: () => {
      if (presenceDebounceTimer) {
        clearTimeout(presenceDebounceTimer);
        presenceDebounceTimer = undefined;
      }
    } },
    // "Handoff quase-instantâneo de lease" (ver scheduleBufferPulse acima) —
    // registrado uma vez só (sobrevive a restart do serviço, mesmo padrão dos
    // dois listeners de presença logo acima).
    vscode.workspace.onDidChangeTextDocument((event) => scheduleBufferPulse(event.document)),
    { dispose: () => {
      for (const timer of bufferPulseTimers.values()) {
        clearTimeout(timer);
      }
      bufferPulseTimers.clear();
    } },
  );

  // Ciclo de vida do servidor (start/stop/restart/setPort) delegado ao
  // SyncController, que não toca `vscode` — este `host` é a única cola com o
  // VS Code (criar/parar serviço, ler/gravar config, pedir a porta, avisar).
  const host: SyncControllerHost = {
    startService: (port) => startService(context, logger, port),
    stopService: () => stopService(),
    isClientConnected: () => service?.isClientConnected() ?? false,
    getConfiguredPort: () => vscode.workspace.getConfiguration("syncteam").get<number>("port", DEFAULT_PORT),
    setConfiguredPort: async (port) => {
      await vscode.workspace.getConfiguration("syncteam").update("port", port, vscode.ConfigurationTarget.Workspace);
    },
    promptForPort: (currentPort) =>
      Promise.resolve(
        vscode.window.showInputBox({
          title: "SyncTeam: porta do servidor local",
          prompt: "Porta (127.0.0.1) onde o plugin Studio conecta. Salva no workspace e reinicia o servidor.",
          value: String(currentPort),
          validateInput: (value) => validatePortInput(value),
        }),
      ),
    info: (message) => {
      vscode.window.showInformationMessage(message);
    },
    error: (message) => {
      vscode.window.showErrorMessage(message);
    },
  };
  controller = new SyncController(host, logger);

  // Status bar (barra inferior do VS Code) — item nunca era instanciado apesar
  // de já importado (achado real de teste, sessão 2026-07-15): construído aqui
  // e mantido em sincronia via o próprio evento de mudança de estado do
  // controller, sem precisar de polling.
  const statusBar = new SyncTeamStatusBar(getConnectionState);
  context.subscriptions.push(statusBar, onDidChangeConnectionState(() => statusBar.refresh()));

  context.subscriptions.push(
    vscode.commands.registerCommand("syncteam.showOutput", () => outputChannel?.show(true)),
    vscode.commands.registerCommand("syncteam.refreshSync", () => runRefreshSync(logger)),
    vscode.commands.registerCommand("syncteam.start", () => controller?.start()),
    vscode.commands.registerCommand("syncteam.stop", () => controller?.stop()),
    vscode.commands.registerCommand("syncteam.restart", () => controller?.restart()),
    vscode.commands.registerCommand("syncteam.setPort", () => controller?.setPort()),
  );

  // syncteam.autoStart (default true): quando false, a extensão ativa e
  // registra os comandos, mas NÃO sobe o servidor sozinha — o usuário usa
  // "SyncTeam: Iniciar" (syncteam.start) manualmente. Evita servidor subindo
  // em toda pasta com default.project.json só por navegar o código.
  const autoStart = vscode.workspace.getConfiguration("syncteam").get<boolean>("autoStart", true);
  if (autoStart) {
    // announce:false — o autostart não popa mensagem (sucesso OU falha) a cada
    // abertura do workspace; só os comandos do Command Palette dão feedback
    // visível (foi o que o usuário pediu). Falha de autostart continua só no
    // log, como antes; o estado da status bar (parado) já é o sinal ambiente.
    controller.start({ announce: false }).catch((error: Error) => {
      logger.error(`falha inesperada ao ativar o SyncTeam: ${error.message}`);
    });
  } else {
    logger.info("syncteam.autoStart = false — servidor não iniciado; use 'SyncTeam: Iniciar' para subir manualmente");
  }
}

/**
 * Estado atual da conexão para a status bar (ui-dev) consultar sob demanda.
 * Antes da ativação / sem controlador retorna parado na porta configurada.
 */
export function getConnectionState(): ConnectionState {
  if (controller) {
    return controller.getConnectionState();
  }
  const port = vscode.workspace.getConfiguration("syncteam").get<number>("port", DEFAULT_PORT);
  return { running: false, port, connected: false };
}

/**
 * Assina mudanças de estado (start/stop/restart/setPort e conexão/desconexão
 * do plugin) para a status bar (ui-dev) se atualizar. Retorna um Disposable.
 */
export function onDidChangeConnectionState(listener: (state: ConnectionState) => void): vscode.Disposable {
  if (!controller) {
    return { dispose: () => {} };
  }
  return controller.onDidChangeConnectionState(listener);
}

export function deactivate(): Promise<void> | void {
  return stopService();
}
