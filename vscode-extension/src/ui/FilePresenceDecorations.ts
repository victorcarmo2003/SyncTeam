// SyncTeam — badge `●` + tooltip no Explorer para arquivos que colaboradores
// remotos têm ativos (M4). Porte direto de
// RojoCoop/vscode-extension/src/ui/FilePresenceDecorations.ts, com uma
// adaptação: lá cada presença carregava `filePath` cru; aqui carrega `uuid`
// (identidade de script do SyncTeam desde o M2), então este módulo precisa
// das DUAS direções de resolução (injetadas por quem instancia, ver
// extension.ts): uri -> uuid (para `provideFileDecoration`) e uuid -> uri
// (para saber quais Uris notificar quando a presença muda, ver
// SyncTeamService.resolveDiskPathForUuid).

import * as vscode from "vscode";
import { PresenceTracker } from "../presence/PresenceTracker.js";

const THEME_COLORS = [
  "charts.blue",
  "charts.red",
  "charts.green",
  "charts.yellow",
  "charts.purple",
  "charts.foreground",
  "charts.orange",
  "charts.lines",
];

function getThemeColor(index: number): vscode.ThemeColor {
  return new vscode.ThemeColor(THEME_COLORS[index % THEME_COLORS.length]);
}

export type ResolveUuidForFsPath = (fsPath: string) => string | null;
export type ResolveFsPathForUuid = (uuid: string) => string | null;

export class FilePresenceDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  private readonly subscriptions: vscode.Disposable[] = [];
  private previousUris = new Set<string>();

  constructor(
    private readonly presenceTracker: PresenceTracker,
    private readonly resolveUuidForFsPath: ResolveUuidForFsPath,
    private readonly resolveFsPathForUuid: ResolveFsPathForUuid,
  ) {
    this.subscriptions.push(
      vscode.window.registerFileDecorationProvider(this),
      presenceTracker.onDidChange(() => this.fireChanges()),
    );
  }

  private fireChanges(): void {
    const uris: vscode.Uri[] = [];
    const currentUris = new Set<string>();

    const uuidsWithPresence = new Set(
      this.presenceTracker
        .getAll()
        .map((c) => c.uuid)
        .filter((uuid): uuid is string => uuid !== null),
    );
    for (const uuid of uuidsWithPresence) {
      const fsPath = this.resolveFsPathForUuid(uuid);
      if (fsPath === null) {
        continue; // uuid conhecido mas ainda não materializado em disco (layout não resolvido ainda)
      }
      const uri = vscode.Uri.file(fsPath);
      uris.push(uri);
      currentUris.add(uri.toString());
    }

    // Uris que tinham presença antes e não têm mais precisam ser notificadas
    // também, para o badge sumir.
    for (const prev of this.previousUris) {
      if (!currentUris.has(prev)) {
        uris.push(vscode.Uri.parse(prev));
      }
    }

    this.previousUris = currentUris;

    if (uris.length > 0) {
      this._onDidChangeFileDecorations.fire(uris);
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const uuid = this.resolveUuidForFsPath(uri.fsPath);
    if (uuid === null) {
      return undefined;
    }
    const collaborators = this.presenceTracker.getByUuid(uuid);
    if (collaborators.length === 0) {
      return undefined;
    }

    const first = collaborators[0];
    const colorIdx = this.presenceTracker.getColorIndex(first.clientId);
    const names = collaborators.map((c) => c.displayName).join(", ");

    return {
      badge: "●",
      tooltip: `SyncTeam: sendo editado por ${names}`,
      color: getThemeColor(colorIdx),
    };
  }

  dispose(): void {
    for (const sub of this.subscriptions) {
      sub.dispose();
    }
    this._onDidChangeFileDecorations.dispose();
  }
}
