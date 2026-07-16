// SyncTeam — decora cursor/seleção de colaboradores remotos DENTRO do editor
// de texto (M4). Sem referência para portar (RojoCoop só validou o badge do
// Explorer, ver FilePresenceDecorations.ts) — implementação nova usando
// `vscode.window.createTextEditorDecorationType` + `editor.setDecorations`,
// mesma técnica usada por outras extensões de edição colaborativa em tempo
// real: uma borda fina simulando o "caret" do colaborador + um rótulo com o
// nome (pseudo-elemento `after`) na posição do cursor, e um overlay
// semitransparente na cor do colaborador sobre o texto selecionado.
//
// Uma DecorationType por índice de cor (não por colaborador) — são
// recicladas entre renderizações, seguindo a recomendação da API do VS Code
// de não criar uma `TextEditorDecorationType` nova a cada atualização.

import * as vscode from "vscode";
import { PresenceTracker, getCollaboratorColor, type CollaboratorPresence } from "../presence/PresenceTracker.js";

const PALETTE_SIZE = 8; // mesmo tamanho da paleta de getCollaboratorColor

export type ResolveUuidForFsPath = (fsPath: string) => string | null;

interface ColorDecorationTypes {
  cursor: vscode.TextEditorDecorationType;
  selection: vscode.TextEditorDecorationType;
}

/** Converte "#rrggbb" para "rgba(r, g, b, alpha)" — usado no overlay translúcido de seleção. */
function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.substring(0, 2), 16);
  const g = parseInt(value.substring(2, 4), 16);
  const b = parseInt(value.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function createColorDecorationTypes(color: string): ColorDecorationTypes {
  return {
    // Barra vertical na posição do cursor (simula um "caret" de outra
    // pessoa). O rótulo com o nome é um `after` colocado por DECORATION
    // (renderOptions em cada DecorationOptions, ver collectDecorations) e
    // não no tipo em si, porque o texto do rótulo varia por colaborador
    // mesmo quando duas pessoas compartilham a mesma cor (paleta cíclica de
    // 8 cores, mais de 8 colaboradores simultâneos é o caso extremo aceito).
    cursor: vscode.window.createTextEditorDecorationType({
      borderStyle: "solid",
      borderWidth: "0 0 0 2px",
      borderColor: color,
      overviewRulerColor: color,
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    }),
    selection: vscode.window.createTextEditorDecorationType({
      backgroundColor: hexToRgba(color, 0.25),
    }),
  };
}

export class RemoteCursorDecorations implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly decorationsByColor: ColorDecorationTypes[] = [];

  constructor(
    private readonly presenceTracker: PresenceTracker,
    private readonly resolveUuidForFsPath: ResolveUuidForFsPath,
  ) {
    for (let i = 0; i < PALETTE_SIZE; i++) {
      this.decorationsByColor.push(createColorDecorationTypes(getCollaboratorColor(i)));
    }

    this.subscriptions.push(
      presenceTracker.onDidChange(() => this.renderAll()),
      vscode.window.onDidChangeActiveTextEditor(() => this.renderAll()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderAll()),
    );
    this.renderAll();
  }

  private renderAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.renderEditor(editor);
    }
  }

  private renderEditor(editor: vscode.TextEditor): void {
    const uuid = this.resolveUuidForFsPath(editor.document.uri.fsPath);
    const cursorOptionsByColor = new Map<number, vscode.DecorationOptions[]>();
    const selectionRangesByColor = new Map<number, vscode.Range[]>();

    if (uuid !== null) {
      for (const collab of this.presenceTracker.getByUuid(uuid)) {
        this.collectDecorations(editor, collab, cursorOptionsByColor, selectionRangesByColor);
      }
    }

    // Sempre chama setDecorations para TODAS as cores, mesmo com lista
    // vazia — é assim que decorações antigas são limpas (VS Code substitui
    // o conjunto inteiro daquele DecorationType nesse editor).
    for (let i = 0; i < PALETTE_SIZE; i++) {
      editor.setDecorations(this.decorationsByColor[i].cursor, cursorOptionsByColor.get(i) ?? []);
      editor.setDecorations(this.decorationsByColor[i].selection, selectionRangesByColor.get(i) ?? []);
    }
  }

  private collectDecorations(
    editor: vscode.TextEditor,
    collab: CollaboratorPresence,
    cursorOptionsByColor: Map<number, vscode.DecorationOptions[]>,
    selectionRangesByColor: Map<number, vscode.Range[]>,
  ): void {
    if (collab.cursorLine === null || collab.cursorColumn === null) {
      return;
    }
    const colorIndex = this.presenceTracker.getColorIndex(collab.clientId) % PALETTE_SIZE;
    const color = getCollaboratorColor(colorIndex);
    const cursorPos = this.clampPosition(editor, collab.cursorLine, collab.cursorColumn);
    const cursorRange = new vscode.Range(cursorPos, cursorPos);

    const options: vscode.DecorationOptions = {
      range: cursorRange,
      hoverMessage: collab.displayName,
      renderOptions: {
        after: {
          contentText: ` ${collab.displayName}`,
          color: "#ffffff",
          backgroundColor: color,
          margin: "0 4px 0 0",
          fontWeight: "normal",
        },
      },
    };
    const cursorList = cursorOptionsByColor.get(colorIndex) ?? [];
    cursorList.push(options);
    cursorOptionsByColor.set(colorIndex, cursorList);

    if (collab.selectionStartLine !== null && collab.selectionStartColumn !== null) {
      const anchor = this.clampPosition(editor, collab.selectionStartLine, collab.selectionStartColumn);
      // Range normaliza start/end automaticamente mesmo se anchor vier
      // depois de cursorPos (seleção "de trás para frente").
      const selectionRange = new vscode.Range(anchor, cursorPos);
      if (!selectionRange.isEmpty) {
        const selectionList = selectionRangesByColor.get(colorIndex) ?? [];
        selectionList.push(selectionRange);
        selectionRangesByColor.set(colorIndex, selectionList);
      }
    }
  }

  /**
   * Protege contra posição fora dos limites do documento LOCAL — pode
   * acontecer se o colaborador remoto está vendo uma versão do arquivo com
   * mais/menos linhas no momento (edição concorrente ainda não convergida).
   * Aproximação aceita para o M4 (clampa em vez de reconciliar char-a-char,
   * fora de escopo do v1 — ver docs/DECISIONS.md "conflito no mesmo arquivo").
   */
  private clampPosition(editor: vscode.TextEditor, line: number, column: number): vscode.Position {
    const lineCount = editor.document.lineCount;
    const clampedLine = Math.max(0, Math.min(line, Math.max(0, lineCount - 1)));
    const lineLength = editor.document.lineAt(clampedLine).text.length;
    const clampedColumn = Math.max(0, Math.min(column, lineLength));
    return new vscode.Position(clampedLine, clampedColumn);
  }

  dispose(): void {
    for (const sub of this.subscriptions) {
      sub.dispose();
    }
    for (const decoration of this.decorationsByColor) {
      decoration.cursor.dispose();
      decoration.selection.dispose();
    }
  }
}
