// SyncTeam — aviso visual persistente quando o arquivo aberto está sob lease
// de outro colaborador (M3.4). Antes desta tarefa só existia a metade
// "Studio nega a escrita" (writeRejected, ver extension.ts) mais um
// showWarningMessage PONTUAL na hora da rejeição — nada impedia o usuário de
// continuar digitando livremente num arquivo cujo lease é alheia, e não
// havia nenhum indicador persistente enquanto isso durava.
//
// Mesmo padrão de construtor/ciclo de vida de RemoteCursorDecorations.ts:
// TextEditorDecorationType criadas 1x e recicladas (nunca recriadas a cada
// render), escuta onDidChangeActiveTextEditor/onDidChangeVisibleTextEditors,
// itera vscode.window.visibleTextEditors, e SEMPRE chama
// editor.setDecorations(tipo, []) para limpar quando não aplicável.
//
// Decisão de design (sem referência para portar — RojoCoop não tinha isto):
// VS Code não tem "borda da janela do editor" nativa. Duas opções avaliadas:
//   A) overlay de backgroundColor translúcido cobrindo do início ao fim do
//      documento (isWholeLine + Range do documento inteiro);
//   B) borda em cada linha via borderStyle/borderWidth/borderColor.
// Escolhida A: uma borda por linha (B) fica visualmente poluída em arquivos
// longos (parece um "grid" de retângulos, não uma borda única ao redor da
// área) e o efeito de "moldura" que o usuário pediu não se sustenta ao
// rolar o arquivo. O overlay de fundo (A) permanece visível em qualquer
// posição de rolagem, com alpha baixo o suficiente para não brigar com a
// sintaxe. overviewRulerColor reforça o aviso na régua/minimap mesmo fora da
// área visível — mesma técnica já usada em RemoteCursorDecorations.
//
// Limitação conhecida, documentada em vez de contornada com hack (pesquisa
// feita nesta tarefa, ver .claude/agent-memory/ui-dev.md): não existe
// `editor.options.readOnly` por editor sem um FileSystemProvider customizado
// (fora de escopo — mudaria como TODO o workspace lê/escreve, não só
// arquivos sob lease), e `vscode.workspace.onWillSaveTextDocument` não tem
// forma limpa de VETAR o save (`waitUntil` só aceita um
// `Thenable<TextEdit[]>` para aplicar edições antes de salvar; não existe
// `preventDefault`/cancelamento — confirmado via pesquisa na documentação e
// em issues do repositório microsoft/vscode). Por isso este módulo só
// REFORÇA o aviso no momento do save (showWarningMessage bloqueante); a
// negativa de verdade continua vindo depois, do lado do Studio
// (writeRejected).

import * as vscode from "vscode";
import type { LeaseTracker } from "../sync/LeaseTracker.js";
import { computeLeaseBorderState, STRINGS } from "./leaseBorderState.js";

/** Lease tracker é recriado a cada conexão nova (ver SyncTeamService.onClientConnected) — por isso um getter, não um valor capturado na criação. */
export type GetLeaseTracker = () => LeaseTracker | null;
export type ResolveUuidForFsPath = (fsPath: string) => string | null;

// Laranja translúcido — mesma família de cor de "atenção/conectando" já
// adotada no painel do plugin (Theme.ConnectConnecting, ver
// .claude/agent-memory/ui-dev.md M4.5+), para manter a linguagem visual de
// aviso consistente entre os dois lados (Studio e VS Code).
const WARNING_BACKGROUND = "rgba(224, 132, 32, 0.14)";
const WARNING_ACCENT = "rgba(224, 132, 32, 0.9)";

export class LeaseBorderDecoration implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly overlayDecoration: vscode.TextEditorDecorationType;
  // Tipo separado (sem backgroundColor) só para o rótulo "after" — o texto
  // varia por dono, então não pode viver como opção fixa do tipo reciclado.
  private readonly labelDecoration: vscode.TextEditorDecorationType;

  constructor(
    private readonly getLeaseTracker: GetLeaseTracker,
    private readonly resolveUuidForFsPath: ResolveUuidForFsPath,
  ) {
    this.overlayDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: WARNING_BACKGROUND,
      overviewRulerColor: WARNING_ACCENT,
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    });
    this.labelDecoration = vscode.window.createTextEditorDecorationType({});

    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.renderAll()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderAll()),
      vscode.workspace.onWillSaveTextDocument((event) => this.onWillSave(event)),
    );
    this.renderAll();
  }

  /** Chamado pela camada de ativação (extension.ts) quando `leaseChanged` chega. */
  renderAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.renderEditor(editor);
    }
  }

  private renderEditor(editor: vscode.TextEditor): void {
    const uuid = this.resolveUuidForFsPath(editor.document.uri.fsPath);
    const state = computeLeaseBorderState(this.getLeaseTracker(), uuid);

    if (!state.locked) {
      // Sempre limpar os dois tipos — é assim que o VS Code remove
      // decorações antigas (substitui o conjunto inteiro daquele tipo).
      editor.setDecorations(this.overlayDecoration, []);
      editor.setDecorations(this.labelDecoration, []);
      return;
    }

    const owner = state.ownerName ?? STRINGS.fallbackOwnerName;
    const document = editor.document;
    const lastLine = document.lineCount - 1;
    const fullDocumentRange = new vscode.Range(0, 0, lastLine, document.lineAt(lastLine).text.length);

    editor.setDecorations(this.overlayDecoration, [
      { range: fullDocumentRange, hoverMessage: STRINGS.hoverMessage(owner) },
    ]);

    // Rótulo ancorado no fim da primeira linha (renderOptions.after) —
    // reforço passivo, sempre visível assim que o arquivo abre, sem
    // depender de hover.
    const firstLine = document.lineAt(0);
    const labelRange = new vscode.Range(0, firstLine.text.length, 0, firstLine.text.length);
    editor.setDecorations(this.labelDecoration, [
      {
        range: labelRange,
        renderOptions: {
          after: {
            contentText: ` ${STRINGS.labelText(owner)}`,
            color: WARNING_ACCENT,
            fontStyle: "italic",
            margin: "0 0 0 1.5rem",
          },
        },
      },
    ]);
  }

  /**
   * Reforço no momento de salvar. LIMITAÇÃO CONHECIDA (ver comentário no topo
   * do arquivo): não há forma limpa de vetar o save aqui — isto só mostra um
   * aviso bloqueante adicional; o save prossegue e a rejeição real continua
   * vindo do lado do Studio.
   */
  private onWillSave(event: vscode.TextDocumentWillSaveEvent): void {
    const uuid = this.resolveUuidForFsPath(event.document.uri.fsPath);
    const state = computeLeaseBorderState(this.getLeaseTracker(), uuid);
    if (!state.locked) {
      return;
    }
    const owner = state.ownerName ?? STRINGS.fallbackOwnerName;
    const fileName = event.document.uri.fsPath.split(/[\\/]/).pop() ?? event.document.uri.fsPath;
    vscode.window.showWarningMessage(STRINGS.saveWarning(owner, fileName));
  }

  dispose(): void {
    for (const sub of this.subscriptions) {
      sub.dispose();
    }
    this.overlayDecoration.dispose();
    this.labelDecoration.dispose();
  }
}
