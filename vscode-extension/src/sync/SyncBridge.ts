// SyncTeam — orquestração da ponte disco <-> Studio. M2: script deixa de ser
// endereçado por caminho completo no DataModel (frágil a rename/move) e
// passa a ser endereçado por UUID (alocado e mantido pelo plugin, via
// TestService.SyncTeam.Scripts.<uuid> — não é responsabilidade deste
// módulo). `path` nas mensagens do protocolo v2 é só informativo/exibição;
// todo lookup interno é por uuid.
//
// Padrão de dedupe (ver .claude/agent-memory/extension-dev.md): todo cache é
// atualizado ANTES de tocar disco/rede, nunca depois — evita eco entre
// disco->Studio e Studio->disco sem precisar rastrear "quem originou".
//
// Este módulo não sabe nada de WebSocket nem de vscode.workspace.fs — só
// recebe um `Transport` (para mandar readSource/writeSource) e um `DiskIO`
// (para tocar disco). Isso o mantém testável com node:fs puro + um transport
// fake, sem precisar do VS Code nem de um plugin real.

import { computeFullLayout, resolveDataModelPathForDiskChange, type DataModelEntry, type MountPoint } from "../mapping/projectMapping.js";
import { isInsideExcludedPackageFolder } from "../mapping/wallyPackageFolders.js";
import { isValidClassName, type ScriptClassName } from "../protocol.js";
import { posixDirname, type DiskIO } from "./DiskIO.js";
import type { Logger } from "../util/logger.js";

/** Vocabulário mínimo que o SyncBridge precisa do canal de comunicação com o plugin. */
export interface Transport {
  request(message: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** Callback para notificar a camada de ativação sobre uma escrita rejeitada. */
export type OnWriteRejectedCallback = (message: { diskPath: string; error: string }) => void;

/**
 * Callback para notificar a camada de ativação sobre um CONFLITO genuíno
 * detectado durante a reconciliação sob demanda ("Refresh Sync"): disco e
 * Studio divergiram AMBOS do último conteúdo sincronizado (ancestral comum) e
 * têm conteúdos diferentes entre si. Nenhum lado é sobrescrito
 * automaticamente — a resolução de conflito legível é M5. Aqui só avisamos
 * para o usuário resolver manualmente.
 */
export type OnSyncConflictCallback = (message: { diskPath: string; uuid: string }) => void;

/** Registro mínimo que o SyncBridge mantém por uuid: path/className atuais, informados pelo plugin. */
interface ScriptEntry {
  /** Caminho completo no DataModel — informativo/exibição e insumo do layout, nunca chave de outro mapa. */
  path: string;
  className: ScriptClassName;
}

function contentCacheKey(diskPath: string): string {
  // Comparação case-insensitive: Windows/NTFS não distingue caixa (regra de
  // .claude/rules/typescript.md).
  return diskPath.toLowerCase();
}

export class SyncBridge {
  // uuid -> {path, className} conhecidos (fonte de verdade para o layout).
  private readonly scripts = new Map<string, ScriptEntry>();
  // uuid -> última Source conhecida do Studio (independente de onde ela mora
  // em disco no momento).
  private readonly sourceCache = new Map<string, string>();
  // uuid -> diskPath atualmente materializado em disco.
  private readonly diskPathByUuid = new Map<string, string>();
  // diskPath (minúsculo) -> uuid dono do arquivo materializado nesse caminho
  // — mapa reverso usado para resolver edições locais (handleLocalFileChange)
  // sem precisar iterar diskPathByUuid.
  private readonly uuidByDiskPath = new Map<string, string>();
  // diskPath (minúsculo) -> último conteúdo escrito/visto, para dedupe de eco.
  private readonly contentCache = new Map<string, string>();

  constructor(
    private readonly mountPoints: MountPoint[],
    private readonly diskIO: DiskIO,
    private readonly logger: Logger,
    private onWriteRejected?: OnWriteRejectedCallback,
    private onSyncConflict?: OnSyncConflictCallback,
  ) {}

  /** Define um callback para ser chamado quando uma escrita for rejeitada. */
  setOnWriteRejected(callback: OnWriteRejectedCallback): void {
    this.onWriteRejected = callback;
  }

  /** Define um callback para ser chamado quando a reconciliação sob demanda detectar um conflito genuíno. */
  setOnSyncConflict(callback: OnSyncConflictCallback): void {
    this.onSyncConflict = callback;
  }

  /**
   * Resolve o uuid do script materializado em `diskPath` (relativo à raiz do
   * workspace de sincronização), ou `null` se não corresponder a nenhum
   * script sincronizado conhecido. Usado pela camada de presença (M4) para
   * saber "qual script o editor ativo representa" a partir do path do
   * documento aberto — mesmo mapa reverso (`uuidByDiskPath`) que
   * `handleLocalFileChange` já usa, exposto aqui só para leitura.
   */
  resolveUuidForDiskPath(diskPath: string): string | null {
    return this.uuidByDiskPath.get(contentCacheKey(diskPath)) ?? null;
  }

  /**
   * Direção inversa de `resolveUuidForDiskPath`: dado um uuid, o diskPath
   * atualmente materializado para ele, ou `null` se ainda não foi
   * materializado/uuid desconhecido. Usado pela camada de presença (M4,
   * `FilePresenceDecorations`) para saber QUAL uri notificar o VS Code
   * quando a presença de um uuid muda (o `FileDecorationProvider` precisa
   * do Uri, não do uuid, para disparar `onDidChangeFileDecorations`).
   */
  resolveDiskPathForUuid(uuid: string): string | null {
    return this.diskPathByUuid.get(uuid) ?? null;
  }

  // --------------------------------------------------------- layout (Rojo)

  /** Registra `diskPath` como o caminho atual do uuid nos dois mapas (direto e reverso), limpando a entrada reversa antiga. */
  private registerDiskPath(uuid: string, diskPath: string): void {
    const previous = this.diskPathByUuid.get(uuid);
    if (previous !== undefined) {
      this.uuidByDiskPath.delete(contentCacheKey(previous));
    }
    this.diskPathByUuid.set(uuid, diskPath);
    this.uuidByDiskPath.set(contentCacheKey(diskPath), uuid);
  }

  private unregisterDiskPath(uuid: string): void {
    const previous = this.diskPathByUuid.get(uuid);
    if (previous !== undefined) {
      this.uuidByDiskPath.delete(contentCacheKey(previous));
      this.contentCache.delete(contentCacheKey(previous));
    }
    this.diskPathByUuid.delete(uuid);
  }

  private displayPath(uuid: string): string {
    return this.scripts.get(uuid)?.path ?? uuid;
  }

  /**
   * Recalcula o layout completo (a partir de `this.scripts`) e aplica no
   * disco qualquer diferença contra `diskPathByUuid`: materializa path novo
   * (se já houver conteúdo em cache) ou move o arquivo físico existente.
   * Cobre tanto os efeitos diretos de uma mudança quanto efeitos colaterais
   * em OUTROS uuids (ex.: um path novo torna o pai "hasChildren", exigindo
   * promoção arquivo->pasta do pai).
   */
  private async recomputeAndApplyLayout(reason: string): Promise<void> {
    const entries: DataModelEntry[] = Array.from(this.scripts.values(), ({ path, className }) => ({ path, className }));
    const uuidByPath = new Map<string, string>();
    for (const [uuid, entry] of this.scripts) {
      uuidByPath.set(entry.path, uuid);
    }

    let result;
    try {
      result = computeFullLayout(entries, this.mountPoints);
    } catch (error) {
      this.logger.error(`layout: erro recomputando layout (${reason}): ${(error as Error).message}`);
      return;
    }
    for (const ignoredPath of result.ignoredPaths) {
      this.logger.info(`layout: '${ignoredPath}' fora de qualquer ponto de montagem configurado — ignorado`);
    }
    for (const { dataModelPath, diskPath } of result.layout) {
      const uuid = uuidByPath.get(dataModelPath);
      if (uuid === undefined) {
        continue; // não deveria acontecer: todo dataModelPath do layout vem de this.scripts.
      }
      const previous = this.diskPathByUuid.get(uuid);
      if (previous === undefined) {
        const resolvedDiskPath = await this.resolveInitialDiskPath(diskPath);
        this.registerDiskPath(uuid, resolvedDiskPath);
        if (this.sourceCache.has(uuid)) {
          await this.writeToDisk(uuid, resolvedDiskPath, this.sourceCache.get(uuid) as string, `novo path (${reason})`);
        }
        continue;
      }
      if (previous === diskPath) {
        continue;
      }
      await this.moveOnDisk(uuid, previous, diskPath, reason);
    }
  }

  /**
   * Materialização INICIAL de um uuid ainda sem `diskPath` conhecido:
   * `computeLayout` sempre decide extensão `.luau` (regra do projeto), mas se
   * já existir em disco um arquivo `.lua` correspondente (mesmo diretório,
   * mesmo nome-base — típico de um `wally install` puro rodado ANTES do
   * SyncTeam existir no workspace, ou de qualquer outra ferramenta que grave
   * `.lua`), reaproveita esse caminho em vez de criar um `.luau` duplicado ao
   * lado, o que deixaria o `.lua` original órfão. Bug real confirmado
   * testando com Wally de verdade em Studio — ver docs/DECISIONS.md
   * 2026-07-16. Escopo estritamente limitado à primeira materialização
   * (chamado só quando `diskPathByUuid.get(uuid) === undefined`); rename/move
   * de scripts já sincronizados (`moveOnDisk`) não passa por aqui.
   */
  private async resolveInitialDiskPath(computedDiskPath: string): Promise<string> {
    const luaCandidate = computedDiskPath.replace(/\.luau$/i, ".lua");
    if (luaCandidate === computedDiskPath) {
      // Não deveria acontecer: computeLayout sempre produz `.luau`. Guarda
      // defensiva caso essa premissa mude no futuro.
      return computedDiskPath;
    }
    try {
      const existing = await this.diskIO.readFile(luaCandidate);
      if (existing !== null) {
        this.logger.info(
          `layout: '${luaCandidate}' já existe em disco (provável instalação Wally anterior ao SyncTeam) — ` +
            `reaproveitando em vez de criar '${computedDiskPath}'`,
        );
        return luaCandidate;
      }
    } catch (error) {
      this.logger.error(`layout: erro checando existência de '${luaCandidate}': ${(error as Error).message}`);
    }
    return computedDiskPath;
  }

  private async writeToDisk(uuid: string, diskPath: string, content: string, reason: string): Promise<void> {
    const key = contentCacheKey(diskPath);
    if (this.contentCache.get(key) === content) {
      return;
    }
    const isNew = !this.contentCache.has(key);
    this.contentCache.set(key, content);
    try {
      await this.diskIO.writeFile(diskPath, content);
      this.logger.info(`Studio → disco: '${diskPath}' (${this.displayPath(uuid)}) ${isNew ? "criado" : "atualizado"} (${reason})`);
    } catch (error) {
      this.logger.error(`Studio → disco: erro escrevendo '${diskPath}': ${(error as Error).message}`);
    }
  }

  /**
   * Move o arquivo físico de `oldDiskPath` para `newDiskPath` usando
   * `DiskIO.renameFile` (M2) — preserva conteúdo sem round-trip de
   * leitura/escrita. Se o arquivo antigo não existir de fato (ex.: ainda não
   * materializado), recorre ao `sourceCache` e escreve do zero no destino.
   */
  private async moveOnDisk(uuid: string, oldDiskPath: string, newDiskPath: string, reason: string): Promise<void> {
    const oldKey = contentCacheKey(oldDiskPath);
    const newKey = contentCacheKey(newDiskPath);

    try {
      await this.diskIO.renameFile(oldDiskPath, newDiskPath);
    } catch (error) {
      this.logger.error(
        `layout: erro movendo '${oldDiskPath}' -> '${newDiskPath}' (${(error as Error).message}); tentando recuperar do sourceCache`,
      );
      const fallbackContent = this.sourceCache.get(uuid);
      this.contentCache.delete(oldKey);
      if (fallbackContent === undefined) {
        this.logger.error(`layout: '${oldDiskPath}' -> '${newDiskPath}': nada para escrever (arquivo antigo ausente e conteúdo desconhecido)`);
        return;
      }
      this.contentCache.set(newKey, fallbackContent);
      try {
        await this.diskIO.writeFile(newDiskPath, fallbackContent);
      } catch (writeError) {
        this.logger.error(`layout: erro escrevendo '${newDiskPath}' no fallback: ${(writeError as Error).message}`);
        return;
      }
      this.registerDiskPath(uuid, newDiskPath);
      return;
    }

    const content = this.contentCache.get(oldKey) ?? this.sourceCache.get(uuid);
    this.contentCache.delete(oldKey);
    if (content !== undefined) {
      this.contentCache.set(newKey, content);
    }
    this.registerDiskPath(uuid, newDiskPath);
    await this.diskIO.removeEmptyDirsUpward(posixDirname(oldDiskPath));
    this.logger.info(`layout: '${oldDiskPath}' -> '${newDiskPath}' (${reason})`);
  }

  // ------------------------------------------------------ Studio -> disco

  private async applyStudioContent(uuid: string, content: string, reason: string): Promise<void> {
    this.sourceCache.set(uuid, content);
    const diskPath = this.diskPathByUuid.get(uuid);
    if (diskPath === undefined) {
      this.logger.info(
        `Studio → disco: '${this.displayPath(uuid)}' com conteúdo em cache, mas layout ainda não resolvido (fora de mount ou uuid desconhecido) — nada escrito ainda (${reason})`,
      );
      return;
    }
    await this.writeToDisk(uuid, diskPath, content, reason);
  }

  /** Chamado quando o plugin conecta (hello validado): listScripts + readSource de cada um. */
  async runInitialSync(transport: Transport): Promise<void> {
    this.logger.info("sincronização inicial: listScripts");
    let response: Record<string, unknown>;
    try {
      response = await transport.request({ kind: "listScripts" });
    } catch (error) {
      this.logger.error(`sincronização inicial: listScripts falhou: ${(error as Error).message}`);
      return;
    }

    const scripts = Array.isArray(response.scripts) ? (response.scripts as Array<Record<string, unknown>>) : [];
    const validUuids: string[] = [];
    for (const item of scripts) {
      const uuid = item?.uuid;
      const path = item?.path;
      const className = item?.className;
      if (typeof uuid === "string" && uuid.length > 0 && typeof path === "string" && isValidClassName(className)) {
        this.scripts.set(uuid, { path, className });
        validUuids.push(uuid);
      } else {
        this.logger.error(`sincronização inicial: entrada de listScripts inválida, ignorada: ${JSON.stringify(item).slice(0, 200)}`);
      }
    }
    this.logger.info(`sincronização inicial: ${scripts.length} script(s) reportado(s) pelo plugin`);
    await this.recomputeAndApplyLayout("listScripts inicial");

    for (const uuid of validUuids) {
      try {
        const readResponse = await transport.request({ kind: "readSource", uuid });
        if (readResponse.ok === false) {
          this.logger.error(`sincronização inicial: readSource '${this.displayPath(uuid)}' falhou: ${String(readResponse.error)}`);
          continue;
        }
        const source = typeof readResponse.source === "string" ? readResponse.source : "";
        await this.applyStudioContent(uuid, source, "sincronização inicial");
      } catch (error) {
        this.logger.error(`sincronização inicial: readSource '${this.displayPath(uuid)}' erro: ${(error as Error).message}`);
      }
    }
    this.logger.info("sincronização inicial concluída");
  }

  /**
   * `sourceChanged {uuid, path, source, className, origin?, via?}` — `path`
   * é só informativo (log); o diskPath já conhecido para `uuid` é usado, sem
   * recalcular pelo `path` recebido (regra do M2: uuid é a única chave).
   */
  async handleSourceChanged(message: Record<string, unknown>): Promise<void> {
    const uuid = message.uuid;
    if (typeof uuid !== "string" || uuid.length === 0) {
      this.logger.info("sourceChanged sem uuid válido, ignorado");
      return;
    }

    // Pastas de pacotes Wally (Packages/ServerPackages/DevPackages) ficam de
    // fora do live-edit-sync contínuo — ver docs/DECISIONS.md 2026-07-16.
    // Discovery/identidade (uuid, listScripts) continuam normais; só a
    // propagação de ATUALIZAÇÃO de conteúdo é ignorada aqui.
    const instancePath = this.scripts.get(uuid)?.path ?? (typeof message.path === "string" ? message.path : undefined);
    if (instancePath !== undefined && isInsideExcludedPackageFolder(instancePath)) {
      this.logger.info(`sourceChanged '${instancePath}': dentro de pasta de pacotes Wally — ignorado (live-edit-sync não se aplica)`);
      return;
    }

    const source = typeof message.source === "string" ? message.source : "";
    await this.applyStudioContent(
      uuid,
      source,
      `sourceChanged '${String(message.path ?? "?")}' origin=${String(message.origin ?? "?")} via=${String(message.via ?? "?")}`,
    );
  }

  async handleScriptAdded(message: Record<string, unknown>, transport: Transport): Promise<void> {
    const uuid = message.uuid;
    const path = message.path;
    const className = message.className;
    if (typeof uuid !== "string" || uuid.length === 0 || typeof path !== "string" || !isValidClassName(className)) {
      this.logger.error(`scriptAdded com uuid/path/className inválido, ignorado: ${JSON.stringify(message).slice(0, 200)}`);
      return;
    }
    const previous = this.scripts.get(uuid);
    this.scripts.set(uuid, { path, className });
    this.logger.info(`scriptAdded '${uuid}' '${path}' (${className})`);
    if (previous === undefined || previous.path !== path || previous.className !== className) {
      await this.recomputeAndApplyLayout(`scriptAdded: '${uuid}' ${previous ? `${previous.path}(${previous.className})` : "(novo)"} -> ${path}(${className})`);
    }

    if (this.sourceCache.has(uuid)) {
      return; // conteúdo já conhecido (ex.: writeSource local acabou de criar este uuid).
    }
    try {
      const readResponse = await transport.request({ kind: "readSource", uuid });
      if (readResponse.ok === false) {
        this.logger.error(`scriptAdded '${path}': readSource falhou: ${String(readResponse.error)}`);
        return;
      }
      const source = typeof readResponse.source === "string" ? readResponse.source : "";
      await this.applyStudioContent(uuid, source, "scriptAdded: readSource inicial");
    } catch (error) {
      this.logger.error(`scriptAdded '${path}': erro em readSource: ${(error as Error).message}`);
    }
  }

  /**
   * `scriptMoved {uuid, oldPath, newPath, className}` — rename/move detectado
   * no Studio via ObjectValue. Move o arquivo físico (DiskIO.renameFile) em
   * vez de recriar do zero; `recomputeAndApplyLayout` ao final cobre efeitos
   * colaterais em outros uuids (ex.: pasta antiga que fica vazia, pai que
   * precisa (des)promover).
   */
  async handleScriptMoved(message: Record<string, unknown>): Promise<void> {
    const uuid = message.uuid;
    const oldPath = message.oldPath;
    const newPath = message.newPath;
    const className = message.className;
    if (
      typeof uuid !== "string" ||
      uuid.length === 0 ||
      typeof oldPath !== "string" ||
      typeof newPath !== "string" ||
      !isValidClassName(className)
    ) {
      this.logger.error(`scriptMoved com campos inválidos, ignorado: ${JSON.stringify(message).slice(0, 200)}`);
      return;
    }

    const oldDiskPath = this.diskPathByUuid.get(uuid);
    this.scripts.set(uuid, { path: newPath, className });

    const entries: DataModelEntry[] = Array.from(this.scripts.values(), ({ path, className: c }) => ({ path, className: c }));
    let layoutResult;
    try {
      layoutResult = computeFullLayout(entries, this.mountPoints);
    } catch (error) {
      this.logger.error(`scriptMoved '${uuid}': erro calculando novo layout: ${(error as Error).message}`);
      return;
    }
    const newEntry = layoutResult.layout.find((entry) => entry.dataModelPath === newPath);

    if (newEntry === undefined) {
      this.logger.info(
        `scriptMoved '${uuid}': novo caminho '${newPath}' fora de qualquer ponto de montagem — removendo arquivo local materializado, se houver`,
      );
      if (oldDiskPath !== undefined) {
        this.unregisterDiskPath(uuid);
        try {
          await this.diskIO.deleteFile(oldDiskPath);
          await this.diskIO.removeEmptyDirsUpward(posixDirname(oldDiskPath));
        } catch (error) {
          this.logger.error(`scriptMoved '${uuid}': erro removendo '${oldDiskPath}': ${(error as Error).message}`);
        }
      }
      return;
    }

    const newDiskPath = newEntry.diskPath;
    if (oldDiskPath === undefined) {
      this.logger.info(`scriptMoved '${uuid}': sem arquivo físico anterior conhecido — tratando como materialização nova em '${newDiskPath}'`);
      this.registerDiskPath(uuid, newDiskPath);
      if (this.sourceCache.has(uuid)) {
        await this.writeToDisk(uuid, newDiskPath, this.sourceCache.get(uuid) as string, `scriptMoved sem arquivo anterior`);
      }
    } else if (oldDiskPath === newDiskPath) {
      this.logger.info(`scriptMoved '${uuid}': diskPath não mudou ('${newDiskPath}') apesar do path no DataModel ter mudado`);
    } else {
      await this.moveOnDisk(uuid, oldDiskPath, newDiskPath, `scriptMoved: '${oldPath}' -> '${newPath}'`);
    }

    // Efeitos colaterais em OUTROS uuids (promoção/despromoção de pastas
    // ancestrais). O próprio uuid já está com diskPathByUuid correto, então
    // este recompute não vai movê-lo de novo (previous === diskPath).
    await this.recomputeAndApplyLayout(`scriptMoved: '${oldPath}' -> '${newPath}'`);
  }

  /**
   * Remoção de script no Studio: apaga o arquivo materializado para aquele
   * uuid (nunca pelo `path` recebido — informativo) e limpa as caches.
   */
  async handleScriptRemoved(message: Record<string, unknown>): Promise<void> {
    const uuid = message.uuid;
    if (typeof uuid !== "string" || uuid.length === 0) {
      this.logger.info("scriptRemoved sem uuid válido, ignorado");
      return;
    }
    const diskPath = this.diskPathByUuid.get(uuid);
    this.scripts.delete(uuid);
    this.sourceCache.delete(uuid);
    this.unregisterDiskPath(uuid);
    if (diskPath === undefined) {
      this.logger.info(`scriptRemoved '${uuid}': nenhum arquivo materializado em disco, nada a remover`);
      return;
    }
    try {
      await this.diskIO.deleteFile(diskPath);
      await this.diskIO.removeEmptyDirsUpward(posixDirname(diskPath));
      this.logger.info(`scriptRemoved '${uuid}': arquivo '${diskPath}' removido do disco`);
    } catch (error) {
      this.logger.error(`scriptRemoved '${uuid}': erro removendo '${diskPath}': ${(error as Error).message}`);
    }
  }

  // ------------------------------------------------------ disco -> Studio

  /**
   * Chamado pelo watcher de arquivos (fs.watch/FileSystemWatcher) quando
   * `relDiskPath` (relativo à raiz do workspace de sincronização) muda.
   * Ignora arquivos fora de qualquer ponto de montagem ou que não seguem a
   * convenção Rojo (log informativo, não erro — mesmo comportamento do M1).
   *
   * M2: se `relDiskPath` já tem um uuid conhecido (mapa reverso
   * `uuidByDiskPath`), manda `writeSource {uuid, source}` (modo atualizar).
   * Senão, é um arquivo local novo: manda `writeSource {path, source,
   * className}` (modo criar) e registra o uuid retornado no `writeAck`.
   *
   * Fora de escopo desta fatia (limitação aceita, ver docs/MILESTONES.md):
   * detectar rename/move feito do LADO DO DISCO — continua virando
   * delete+create do lado do Studio (perde a identidade nesse sentido).
   */
  async handleLocalFileChange(relDiskPath: string, transport: Transport): Promise<void> {
    const key = contentCacheKey(relDiskPath);

    let content: string | null;
    try {
      content = await this.diskIO.readFile(relDiskPath);
    } catch (error) {
      this.logger.error(`erro lendo '${relDiskPath}': ${(error as Error).message}`);
      return;
    }
    if (content === null) {
      this.logger.info(
        `'${relDiskPath}' não encontrado (removido?) — remoção local não é propagada ao Studio nesta versão (M2)`,
      );
      this.contentCache.delete(key);
      return;
    }

    if (this.contentCache.get(key) === content) {
      return; // eco de escrita que a própria ponte já fez
    }

    const knownUuid = this.uuidByDiskPath.get(key);
    if (knownUuid !== undefined) {
      // Pastas de pacotes Wally: script JÁ EXISTE (uuid conhecido) — isto é
      // uma ATUALIZAÇÃO de conteúdo existente, que fica de fora do
      // live-edit-sync (ver docs/DECISIONS.md 2026-07-16). Note que a
      // CRIAÇÃO de arquivo novo (branch abaixo, sem uuid conhecido) não
      // passa por este early-return — continua funcionando normalmente
      // mesmo dentro dessas pastas.
      const instancePath = this.scripts.get(knownUuid)?.path ?? relDiskPath;
      if (isInsideExcludedPackageFolder(instancePath)) {
        this.logger.info(
          `disco → Studio: '${relDiskPath}' (uuid '${knownUuid}') dentro de pasta de pacotes Wally — atualização ignorada (live-edit-sync não se aplica)`,
        );
        return;
      }

      this.contentCache.set(key, content);
      this.sourceCache.set(knownUuid, content);
      this.logger.info(`disco → Studio: '${relDiskPath}' (uuid '${knownUuid}') mudou, enviando writeSource (atualizar)`);
      try {
        const ack = await transport.request({ kind: "writeSource", uuid: knownUuid, source: content });
        if (ack.ok) {
          this.logger.info(`disco → Studio: '${relDiskPath}' aplicado no Studio (api=${String(ack.api)})`);
        } else {
          const errorMsg = String(ack.error ?? "motivo desconhecido");
          this.logger.error(`disco → Studio: FALHA aplicando '${relDiskPath}' (uuid '${knownUuid}'): ${errorMsg}`);
          this.onWriteRejected?.({ diskPath: relDiskPath, error: errorMsg });
        }
      } catch (error) {
        this.logger.error(`disco → Studio: erro enviando '${relDiskPath}' (uuid '${knownUuid}'): ${(error as Error).message}`);
      }
      return;
    }

    // Sem uuid conhecido para este diskPath: candidato a arquivo local novo.
    const resolved = resolveDataModelPathForDiskChange(relDiskPath, this.mountPoints);
    if (resolved === null) {
      this.logger.info(
        `'${relDiskPath}' fora de qualquer ponto de montagem ou não segue a convenção de nomenclatura Rojo — ignorado`,
      );
      return;
    }
    const { dataModelPath, className } = resolved;
    this.contentCache.set(key, content);

    this.logger.info(`disco → Studio: '${relDiskPath}' (${dataModelPath}, ${className}) é novo, enviando writeSource (criar)`);
    try {
      const ack = await transport.request({ kind: "writeSource", path: dataModelPath, source: content, className });
      if (ack.ok !== true) {
        const errorMsg = String(ack.error ?? "motivo desconhecido");
        this.logger.error(`disco → Studio: FALHA criando '${relDiskPath}': ${errorMsg}`);
        this.onWriteRejected?.({ diskPath: relDiskPath, error: errorMsg });
        return;
      }
      const newUuid = ack.uuid;
      if (typeof newUuid !== "string" || newUuid.length === 0) {
        this.logger.error(`disco → Studio: writeAck de criação de '${relDiskPath}' veio ok=true sem 'uuid' — não é possível rastrear`);
        return;
      }
      this.scripts.set(newUuid, { path: dataModelPath, className });
      this.sourceCache.set(newUuid, content);
      this.registerDiskPath(newUuid, relDiskPath);
      this.logger.info(`disco → Studio: '${relDiskPath}' criado no Studio como uuid '${newUuid}' (api=${String(ack.api)})`);
      // Efeito colateral possível: este path novo pode fazer um ancestral já
      // conhecido precisar virar pasta (promoção) — mesmo raciocínio de
      // scriptAdded/scriptMoved. O próprio newUuid já está registrado com o
      // diskPath exato que acabamos de escrever, então não é re-movido aqui.
      await this.recomputeAndApplyLayout(`writeSource criado localmente: uuid '${newUuid}' em '${dataModelPath}'`);
    } catch (error) {
      this.logger.error(`disco → Studio: erro enviando '${relDiskPath}': ${(error as Error).message}`);
    }
  }

  // ------------------------------------------------- reconciliação sob demanda

  /**
   * "Refresh Sync": reconciliação bidirecional completa sob demanda. Sincroniza
   * derivas que o watcher / conexão ao vivo tenham perdido — tipicamente quando
   * um processo externo (script .bat/.ps1, ou outra ferramenta) editou um
   * arquivo mapeado enquanto a extensão estava FECHADA. NÃO reimplementa a
   * propagação: é só um novo ponto de entrada que dispara um MERGE DE 3 VIAS
   * para todos os arquivos mapeados de uma vez, reaproveitando os mesmos
   * caminhos de `handleLocalFileChange` (disco→Studio), `applyStudioContent`
   * (Studio→disco, mesmo núcleo de `handleSourceChanged`) e a criação/pull
   * inicial já existentes.
   *
   * O "ancestral comum" do merge de 3 vias é o `contentCache` (último conteúdo
   * sincronizado por diskPath). Para cada uuid conhecido (união de
   * `diskPathByUuid` com um `listScripts` fresco), comparamos o conteúdo ATUAL
   * do disco (`disco`) e o `readSource` fresco do Studio (`studio`) contra esse
   * ancestral (`cache`) — ver `reconcileUuidOnRefresh` para a tabela de
   * decisão. Conflito genuíno (ambos os lados divergiram e diferem entre si)
   * NÃO é resolvido automaticamente: só emite `onSyncConflict` para o usuário
   * resolver (a resolução legível é M5).
   */
  async refreshSync(transport: Transport): Promise<void> {
    this.logger.info("refreshSync: iniciando reconciliação de 3 vias sob demanda");

    let response: Record<string, unknown>;
    try {
      response = await transport.request({ kind: "listScripts" });
    } catch (error) {
      this.logger.error(`refreshSync: listScripts falhou: ${(error as Error).message}`);
      return;
    }

    const rawScripts = Array.isArray(response.scripts) ? (response.scripts as Array<Record<string, unknown>>) : [];
    const pluginScripts = new Map<string, ScriptEntry>();
    for (const item of rawScripts) {
      const uuid = item?.uuid;
      const path = item?.path;
      const className = item?.className;
      if (typeof uuid === "string" && uuid.length > 0 && typeof path === "string" && isValidClassName(className)) {
        pluginScripts.set(uuid, { path, className });
      } else {
        this.logger.error(`refreshSync: entrada de listScripts inválida, ignorada: ${JSON.stringify(item).slice(0, 200)}`);
      }
    }
    this.logger.info(`refreshSync: ${pluginScripts.size} script(s) reportado(s) pelo plugin`);

    // Merge no `this.scripts` (fonte de verdade do layout) e recompute:
    // atribui diskPath a scripts do Studio ainda não vistos localmente e move
    // arquivos de scripts que mudaram de path enquanto a extensão estava
    // fechada (mesmo motor de `scriptAdded`/`scriptMoved`).
    let layoutChanged = false;
    for (const [uuid, entry] of pluginScripts) {
      const prev = this.scripts.get(uuid);
      if (prev === undefined || prev.path !== entry.path || prev.className !== entry.className) {
        this.scripts.set(uuid, entry);
        layoutChanged = true;
      }
    }
    if (layoutChanged) {
      await this.recomputeAndApplyLayout("refreshSync: listScripts fresco");
    }

    // União de uuids: os já materializados localmente + os reportados agora.
    const uuids = new Set<string>([...this.diskPathByUuid.keys(), ...pluginScripts.keys()]);
    for (const uuid of uuids) {
      await this.reconcileUuidOnRefresh(uuid, pluginScripts, transport);
    }

    // Arquivos que existem no disco mas não têm uuid conhecido (ex.: criados
    // por processo externo enquanto a extensão estava fechada) — mesmo caminho
    // de criação de `handleLocalFileChange`.
    await this.reconcileDiskOnlyFiles(transport);

    this.logger.info("refreshSync: reconciliação concluída");
  }

  /**
   * Reconcilia um único uuid durante o "Refresh Sync". Tabela de decisão
   * (com `cache` = `contentCache[diskPath]` = último conteúdo sincronizado):
   *
   * - uuid ausente do listScripts do plugin → deleção no Studio não é
   *   auto-propagada nesta versão; arquivo local preservado (não-destrutivo).
   * - sem ancestral (`cache` indefinido):
   *     - sem arquivo no disco → recém-descoberto no Studio → pull.
   *     - com arquivo no disco: iguais → registra baseline; diferentes →
   *       conflito (sem ancestral não dá pra arbitrar).
   * - com ancestral (`cache` definido):
   *     - disco==cache && studio==cache → no-op.
   *     - só disco mudou → disco→Studio (`handleLocalFileChange`).
   *     - só studio mudou → Studio→disco (`applyStudioContent`).
   *     - ambos mudaram e convergiram (disco==studio) → registra baseline.
   *     - ambos mudaram e divergem → conflito.
   *
   * Pastas de pacotes Wally (`isInsideExcludedPackageFolder`, ver
   * docs/DECISIONS.md 2026-07-16): qualquer ramo acima que faria um PUSH de
   * atualização (só disco mudou, só Studio mudou) ou reportaria CONFLITO
   * (com ou sem ancestral) é pulado silenciosamente (log info) para uuids
   * dentro dessas pastas. O caso "sem ancestral, sem arquivo local" (pull de
   * descoberta) e a convergência (registra baseline) continuam normais —
   * não são push nem conflito.
   */
  private async reconcileUuidOnRefresh(
    uuid: string,
    pluginScripts: Map<string, ScriptEntry>,
    transport: Transport,
  ): Promise<void> {
    const diskPath = this.diskPathByUuid.get(uuid);

    if (!pluginScripts.has(uuid)) {
      this.logger.warn(
        `refreshSync: uuid '${uuid}' (${diskPath ?? this.displayPath(uuid)}) não está mais no listScripts do Studio — ` +
          "arquivo local preservado; deleção no Studio não é propagada nesta versão",
      );
      return;
    }

    if (diskPath === undefined) {
      this.logger.info(`refreshSync: uuid '${uuid}' (${this.displayPath(uuid)}) fora de qualquer ponto de montagem — ignorado`);
      return;
    }

    // Pastas de pacotes Wally: "disco tem e Studio não tem ainda" continua
    // funcionando normal (criação — tratada em reconcileDiskOnlyFiles, não
    // aqui). O que fica de fora aqui é qualquer caso em que AMBOS os lados já
    // existem e divergem — conflito genuíno ou push de atualização — ver
    // docs/DECISIONS.md 2026-07-16.
    const instancePath = pluginScripts.get(uuid)?.path ?? this.displayPath(uuid);
    const excluded = isInsideExcludedPackageFolder(instancePath);

    let studio: string;
    try {
      const readResponse = await transport.request({ kind: "readSource", uuid });
      if (readResponse.ok === false) {
        this.logger.error(`refreshSync: readSource '${this.displayPath(uuid)}' falhou: ${String(readResponse.error)}`);
        return;
      }
      studio = typeof readResponse.source === "string" ? readResponse.source : "";
    } catch (error) {
      this.logger.error(`refreshSync: readSource '${this.displayPath(uuid)}' erro: ${(error as Error).message}`);
      return;
    }

    let disco: string | null;
    try {
      disco = await this.diskIO.readFile(diskPath);
    } catch (error) {
      this.logger.error(`refreshSync: erro lendo '${diskPath}': ${(error as Error).message}`);
      return;
    }

    const key = contentCacheKey(diskPath);
    const cache = this.contentCache.get(key);

    if (cache === undefined) {
      // Sem ancestral comum: um dos casos de existência assimétrica.
      if (disco === null) {
        this.logger.info(`refreshSync: '${this.displayPath(uuid)}' descoberto no Studio (sem arquivo local) → puxando`);
        await this.applyStudioContent(uuid, studio, "refreshSync: descoberto no Studio");
        return;
      }
      if (disco === studio) {
        this.logger.info(`refreshSync: '${diskPath}' já idêntico ao Studio (sem ancestral) → registrando baseline`);
        this.seedBaseline(uuid, key, disco);
        return;
      }
      if (excluded) {
        this.logger.info(
          `refreshSync: '${diskPath}' (${instancePath}) dentro de pasta de pacotes Wally — divergência (sem ancestral) ignorada silenciosamente`,
        );
        return;
      }
      this.reportConflict(uuid, diskPath);
      return;
    }

    if (disco === null) {
      // Arquivo removido do disco externamente. Deleção não é propagada nesta
      // versão (mesma semântica de `handleLocalFileChange`) — não-destrutivo.
      this.logger.warn(
        `refreshSync: '${diskPath}' (${this.displayPath(uuid)}) foi removido do disco externamente — ` +
          "deleção não é propagada nesta versão; ignorado",
      );
      return;
    }

    const discoChanged = disco !== cache;
    const studioChanged = studio !== cache;

    if (!discoChanged && !studioChanged) {
      return; // caso 2: nada mudou
    }
    if (discoChanged && !studioChanged) {
      if (excluded) {
        this.logger.info(
          `refreshSync: '${diskPath}' (${instancePath}) dentro de pasta de pacotes Wally — mudança só no disco ignorada (sem push ao Studio)`,
        );
        return;
      }
      this.logger.info(`refreshSync: '${diskPath}' mudou só no disco → propagando ao Studio`);
      await this.handleLocalFileChange(diskPath, transport);
      return;
    }
    if (!discoChanged && studioChanged) {
      if (excluded) {
        this.logger.info(
          `refreshSync: '${instancePath}' dentro de pasta de pacotes Wally — mudança só no Studio ignorada (sem push ao disco)`,
        );
        return;
      }
      this.logger.info(`refreshSync: '${this.displayPath(uuid)}' mudou só no Studio → propagando ao disco`);
      await this.applyStudioContent(uuid, studio, "refreshSync: só Studio mudou");
      return;
    }
    // Ambos mudaram.
    if (disco === studio) {
      this.logger.info(`refreshSync: '${diskPath}' convergiu (disco == Studio) → atualizando baseline`);
      this.seedBaseline(uuid, key, disco);
      return;
    }
    if (excluded) {
      this.logger.info(
        `refreshSync: '${diskPath}' (${instancePath}) dentro de pasta de pacotes Wally — divergência ignorada silenciosamente (sem push, sem conflito reportado)`,
      );
      return;
    }
    this.reportConflict(uuid, diskPath);
  }

  /**
   * Varre os arquivos sob cada ponto de montagem procurando arquivos que não
   * têm uuid conhecido (não estão em `uuidByDiskPath`) e seguem a convenção
   * Rojo — trata cada um como criação nova via `handleLocalFileChange` (mesmo
   * caminho disco→Studio de criação já existente). Cobre o caso de um processo
   * externo ter criado um arquivo enquanto a extensão estava fechada.
   */
  private async reconcileDiskOnlyFiles(transport: Transport): Promise<void> {
    const seen = new Set<string>();
    for (const mount of this.mountPoints) {
      let files: string[];
      try {
        files = await this.diskIO.listFiles(mount.diskPath);
      } catch (error) {
        this.logger.error(`refreshSync: erro listando arquivos em '${mount.diskPath}': ${(error as Error).message}`);
        continue;
      }
      for (const relPath of files) {
        const key = contentCacheKey(relPath);
        if (seen.has(key)) {
          continue; // mounts podem se sobrepor/aninhar — não processa duas vezes
        }
        seen.add(key);
        if (this.uuidByDiskPath.has(key)) {
          continue; // já rastreado por algum uuid
        }
        if (resolveDataModelPathForDiskChange(relPath, this.mountPoints) === null) {
          continue; // não segue a convenção Rojo (ex.: .json, .txt) — não é script
        }
        this.logger.info(`refreshSync: '${relPath}' existe no disco sem uuid conhecido → tratando como criação nova`);
        await this.handleLocalFileChange(relPath, transport);
      }
    }
  }

  /** Registra `content` como o novo ancestral sincronizado, sem tocar disco nem rede (casos de convergência). */
  private seedBaseline(uuid: string, key: string, content: string): void {
    this.contentCache.set(key, content);
    this.sourceCache.set(uuid, content);
  }

  /**
   * Conflito genuíno: NÃO sobrescreve nenhum lado e NÃO mexe no ancestral
   * (`contentCache`) — assim, quando o usuário resolver salvando um dos lados,
   * aquela edição ainda diverge do ancestral e propaga normalmente. Só avisa.
   */
  private reportConflict(uuid: string, diskPath: string): void {
    this.logger.warn(
      `refreshSync: CONFLITO em '${diskPath}' (${this.displayPath(uuid)}) — disco e Studio divergiram ambos do último ` +
        "conteúdo sincronizado e diferem entre si; nenhum lado foi sobrescrito, resolva manualmente",
    );
    this.onSyncConflict?.({ diskPath, uuid });
  }
}
