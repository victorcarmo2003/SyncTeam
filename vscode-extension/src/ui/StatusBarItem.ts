// SyncTeam — item da barra de status (barra inferior do VS Code). Mostra o
// estado da conexão + porta num relance e, ao clicar, abre um QuickPick com as
// ações (iniciar/parar/trocar porta/refresh/log). Paridade com o painel do
// plugin Studio (toggle + porta).
//
// Toda a LÓGICA (que texto/ícone mostrar, quais opções listar) vive no módulo
// PURO `statusBarMenu.ts` (testável com vitest, sem `vscode`); aqui fica só a
// parte que fala com a API do VS Code. Estado é lido ao vivo via `getState`
// (injetado por extension.ts, fechado sobre `service`/config) — este arquivo
// não conhece SyncTeamService nem a config diretamente.

import * as vscode from "vscode";
import {
  buildMenuOptions,
  buildStatusVisual,
  STRINGS,
  type ConnectionState,
} from "./statusBarMenu.js";

// Comando interno disparado pelo clique no item. Registrado via
// registerCommand (não em package.json contributes.commands) de propósito:
// funciona como alvo do clique sem poluir a paleta de comandos.
const MENU_COMMAND_ID = "syncteam.statusBarMenu";
// Prioridade moderada no grupo à direita (maior = mais à esquerda dentro do
// grupo). Não precisa ficar colado na borda.
const STATUS_BAR_PRIORITY = 100;

interface MenuQuickPickItem extends vscode.QuickPickItem {
  command: string;
}

export class SyncTeamStatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  // Dedupe: o poll de extension.ts chama refresh() a cada segundo; só tocamos
  // as props do item quando algo realmente muda (mesma disciplina de dedupe do
  // plugin, ver .claude/agent-memory/ui-dev.md).
  private lastSignature = "";

  constructor(private readonly getState: () => ConnectionState) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, STATUS_BAR_PRIORITY);
    this.item.name = "SyncTeam";
    this.item.command = MENU_COMMAND_ID;

    this.disposables.push(
      vscode.commands.registerCommand(MENU_COMMAND_ID, () => this.showMenu()),
      // Porta pode mudar na config sem passar por um restart observável aqui;
      // reagir na hora evita esperar o próximo ciclo do poll.
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("syncteam.port")) {
          this.refresh();
        }
      }),
    );

    this.item.show();
    this.refresh();
  }

  /** Relê o estado e reaplica texto/tooltip/fundo (no-op se nada mudou). */
  refresh(): void {
    const visual = buildStatusVisual(this.getState());
    const signature = `${visual.text}|${visual.tooltip}|${visual.warning ? "1" : "0"}`;
    if (signature === this.lastSignature) {
      return;
    }
    this.lastSignature = signature;

    this.item.text = visual.text;
    this.item.tooltip = visual.tooltip;
    this.item.backgroundColor = visual.warning
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
  }

  private async showMenu(): Promise<void> {
    const items: MenuQuickPickItem[] = buildMenuOptions(this.getState()).map((option) => ({
      label: option.label,
      detail: option.detail,
      command: option.command,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: STRINGS.menuPlaceholder,
    });
    if (picked) {
      await vscode.commands.executeCommand(picked.command);
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.item.dispose();
  }
}
