// SyncTeam — decora cursor/seleção de colaboradores remotos DENTRO do editor
// de texto (M4). Sem referência para portar (RojoCoop só validou o badge do
// Explorer, ver FilePresenceDecorations.ts) — implementação usando
// `vscode.window.createTextEditorDecorationType` + `editor.setDecorations`.
//
// Ajuste de UX (2026-07-29, pedido literal do usuário): o rótulo com o nome
// do colaborador ERA um pseudo-elemento `after` INLINE (empurrava o texto real
// do documento pra abrir espaço pra si — se o cursor remoto estava no meio de
// uma palavra, o texto local ficava ilegível, ex. `module.Func[nome]tion()`).
// Removido. Agora:
// - A barra vertical (`borderWidth: "0 0 0 2px"`, cor do colaborador) continua
//   na posição EXATA do cursor remoto, mas agora PISCA (alterna visível/oculta
//   num intervalo, ver BLINK_INTERVAL_MS) para lembrar um cursor de texto
//   nativo — a API de decoração do VS Code não tem `@keyframes`/CSS
//   animation, então o "pisca" é simulado por `setInterval` alternando entre
//   a lista de decorações e uma lista vazia no MESMO DecorationType (técnica
//   padrão para animação de decoração, evita recriar o tipo a cada frame).
// - O nome só aparece quando o usuário LOCAL passa o mouse em cima da barra
//   (hover nativo do VS Code), nunca mais desloca texto ao redor. Implementado
//   com um DecorationType SEPARADO e invisível (`hoverArea`) cobrindo uma
//   range um pouco mais larga que o cursor (1 caractere, pra não depender de
//   acertar um alvo de largura zero com o mouse) — esse tipo NÃO pisca (fica
//   sempre presente), então o hover funciona mesmo na fase "apagada" do pisca
//   da barra visual.
// - O hover usa `vscode.MarkdownString` com `supportHtml: true` e um `<span>`
//   com `style` inline (fundo na cor do colaborador, texto branco) para
//   lembrar visualmente o "quadrado colorido" que existia antes, em vez de um
//   tooltip de texto puro. Confirmado por pesquisa
//   (.claude/research/2026-07-29-markdownstring-supporthtml-span-style-badge.md)
//   que o sanitizador de HTML do VS Code permite, SOMENTE em `<span>` e
//   SOMENTE nessa ordem exata, `color`/`background-color`/`border-radius`
//   (hex ou `var(--vscode-*)`, sem `padding`/`display`) — `&nbsp;` é usado
//   como respiro visual em vez de `padding` (não sobrevive à sanitização).
//
// Uma DecorationType por índice de cor (não por colaborador) — são
// recicladas entre renderizações, seguindo a recomendação da API do VS Code
// de não criar uma `TextEditorDecorationType` nova a cada atualização.

import * as vscode from "vscode";
import { PresenceTracker, getCollaboratorColor, type CollaboratorPresence } from "../presence/PresenceTracker.js";

const PALETTE_SIZE = 8; // mesmo tamanho da paleta de getCollaboratorColor

/**
 * Cadência do pisca da barra do cursor remoto. Sem precisão milimétrica
 * pedida — só "perto do cursor de texto nativo do VS Code/SO" (tipicamente
 * ~500-530ms por fase). Cada fase (visível/oculta) dura esse intervalo.
 */
const BLINK_INTERVAL_MS = 530;

export type ResolveUuidForFsPath = (fsPath: string) => string | null;

interface ColorDecorationTypes {
  /** Barra vertical na posição do cursor — pisca (ver BLINK_INTERVAL_MS). */
  cursor: vscode.TextEditorDecorationType;
  /**
   * Invisível (nenhum estilo visual próprio) — existe só para carregar o
   * `hoverMessage` numa área um pouco mais larga que a barra do cursor, sem
   * nunca deslocar texto (ao contrário do antigo `renderOptions.after`).
   * Nunca pisca: precisa estar sempre presente para o hover funcionar mesmo
   * na fase "oculta" do pisca da barra visual.
   */
  hoverArea: vscode.TextEditorDecorationType;
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

/** Escapa texto livre (nome de colaborador) antes de embutir em HTML do hover. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Badge colorido (fundo na cor do colaborador, texto branco) para o hover da
 * barra do cursor remoto. `style` inline só sobrevive à sanitização do VS
 * Code em `<span>`, nessa ordem exata `color;background-color;border-radius`
 * — ver research citada no topo do arquivo. `padding` não é permitido; o
 * respiro visual vem de `&nbsp;` no próprio texto.
 */
function buildHoverBadge(displayName: string, color: string): vscode.MarkdownString {
  const style = `color:#ffffff;background-color:${color};border-radius:3px;`;
  const markdown = new vscode.MarkdownString(`<span style="${style}">&nbsp;${escapeHtml(displayName)}&nbsp;</span>`);
  markdown.supportHtml = true;
  return markdown;
}

function createColorDecorationTypes(color: string): ColorDecorationTypes {
  return {
    // Barra vertical na posição do cursor (simula um "caret" de outra
    // pessoa). Sem hoverMessage/renderOptions aqui — o hover vive em
    // `hoverArea` (tipo separado, não pisca) e o nome nunca mais desloca
    // texto (era o pseudo-elemento `after` antigo, removido).
    cursor: vscode.window.createTextEditorDecorationType({
      borderStyle: "solid",
      borderWidth: "0 0 0 2px",
      borderColor: color,
      overviewRulerColor: color,
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    }),
    // Sem nenhuma propriedade visual — existe só para anexar hoverMessage
    // numa range um pouco mais larga (ver computeHoverRange), facilitando o
    // usuário acertar o mouse sem depender de um alvo de largura zero.
    hoverArea: vscode.window.createTextEditorDecorationType({}),
    selection: vscode.window.createTextEditorDecorationType({
      backgroundColor: hexToRgba(color, 0.25),
    }),
  };
}

export class RemoteCursorDecorations implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly decorationsByColor: ColorDecorationTypes[] = [];
  /** Fase atual do pisca da barra do cursor (true = visível). */
  private blinkVisible = true;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly presenceTracker: PresenceTracker,
    private readonly resolveUuidForFsPath: ResolveUuidForFsPath,
  ) {
    for (let i = 0; i < PALETTE_SIZE; i++) {
      this.decorationsByColor.push(createColorDecorationTypes(getCollaboratorColor(i)));
    }

    this.subscriptions.push(
      presenceTracker.onDidChange(() => this.resetBlinkAndRenderAll()),
      vscode.window.onDidChangeActiveTextEditor(() => this.resetBlinkAndRenderAll()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.resetBlinkAndRenderAll()),
    );
    this.renderAll();

    // Simula o "pisca" do cursor: a API de decoração não tem @keyframes/CSS
    // animation, então alternamos entre mostrar e ocultar a barra do cursor
    // (não a hoverArea, que fica sempre presente) num intervalo fixo.
    this.blinkTimer = setInterval(() => {
      this.blinkVisible = !this.blinkVisible;
      this.renderAll();
    }, BLINK_INTERVAL_MS);
  }

  /**
   * Reinicia a fase do pisca para "visível" antes de renderizar — um cursor
   * remoto que acabou de aparecer/mover deve aparecer sólido na hora, não em
   * qualquer fase aleatória do ciclo em andamento.
   */
  private resetBlinkAndRenderAll(): void {
    this.blinkVisible = true;
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
    const hoverOptionsByColor = new Map<number, vscode.DecorationOptions[]>();
    const selectionRangesByColor = new Map<number, vscode.Range[]>();

    if (uuid !== null) {
      for (const collab of this.presenceTracker.getByUuid(uuid)) {
        this.collectDecorations(editor, collab, cursorOptionsByColor, hoverOptionsByColor, selectionRangesByColor);
      }
    }

    // Sempre chama setDecorations para TODAS as cores, mesmo com lista
    // vazia — é assim que decorações antigas são limpas (VS Code substitui
    // o conjunto inteiro daquele DecorationType nesse editor).
    for (let i = 0; i < PALETTE_SIZE; i++) {
      // A barra pisca: na fase "oculta" manda lista vazia mesmo havendo
      // colaborador ali. A hoverArea NUNCA pisca — precisa estar sempre
      // presente para o hover funcionar em qualquer fase.
      editor.setDecorations(this.decorationsByColor[i].cursor, this.blinkVisible ? (cursorOptionsByColor.get(i) ?? []) : []);
      editor.setDecorations(this.decorationsByColor[i].hoverArea, hoverOptionsByColor.get(i) ?? []);
      editor.setDecorations(this.decorationsByColor[i].selection, selectionRangesByColor.get(i) ?? []);
    }
  }

  private collectDecorations(
    editor: vscode.TextEditor,
    collab: CollaboratorPresence,
    cursorOptionsByColor: Map<number, vscode.DecorationOptions[]>,
    hoverOptionsByColor: Map<number, vscode.DecorationOptions[]>,
    selectionRangesByColor: Map<number, vscode.Range[]>,
  ): void {
    if (collab.cursorLine === null || collab.cursorColumn === null) {
      return;
    }
    const colorIndex = this.presenceTracker.getColorIndex(collab.clientId) % PALETTE_SIZE;
    const color = getCollaboratorColor(colorIndex);
    const cursorPos = this.clampPosition(editor, collab.cursorLine, collab.cursorColumn);
    const cursorRange = new vscode.Range(cursorPos, cursorPos);

    // Barra visual: SEM hoverMessage/renderOptions — só a posição exata,
    // nunca desloca texto ao redor.
    const cursorList = cursorOptionsByColor.get(colorIndex) ?? [];
    cursorList.push({ range: cursorRange });
    cursorOptionsByColor.set(colorIndex, cursorList);

    // Área de hover: range um pouco mais larga (facilita acertar o mouse),
    // nunca pisca, carrega o badge colorido com o nome.
    const hoverList = hoverOptionsByColor.get(colorIndex) ?? [];
    hoverList.push({
      range: this.computeHoverRange(editor, cursorPos),
      hoverMessage: buildHoverBadge(collab.displayName, color),
    });
    hoverOptionsByColor.set(colorIndex, hoverList);

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
   * Amplia a posição exata do cursor (largura zero) para uma range de 1
   * caractere, só para efeito de hit-area do hover — a barra visual
   * continua ancorada em `cursorPos` exato (não usa esta range). Prefere
   * estender para a DIREITA (mesmo lado onde a barra "abre espaço" ao
   * digitar); se não houver caractere à direita (fim de linha), estende
   * para a ESQUERDA; se a linha estiver vazia, mantém largura zero (nada
   * pra ancorar de qualquer forma).
   */
  private computeHoverRange(editor: vscode.TextEditor, pos: vscode.Position): vscode.Range {
    const lineLength = editor.document.lineAt(pos.line).text.length;
    if (pos.character < lineLength) {
      return new vscode.Range(pos, pos.translate(0, 1));
    }
    if (pos.character > 0) {
      return new vscode.Range(pos.translate(0, -1), pos);
    }
    return new vscode.Range(pos, pos);
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
    if (this.blinkTimer !== null) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
    for (const sub of this.subscriptions) {
      sub.dispose();
    }
    for (const decoration of this.decorationsByColor) {
      decoration.cursor.dispose();
      decoration.hoverArea.dispose();
      decoration.selection.dispose();
    }
  }
}
