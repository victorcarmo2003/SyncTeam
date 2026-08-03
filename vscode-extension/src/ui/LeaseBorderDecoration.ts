// SyncTeam — aviso visual persistente quando o arquivo aberto está sob lease
// de outro colaborador (M3.4, revisado 2026-08-02). Antes de M3.4 só existia
// a metade "Studio nega a escrita" (writeRejected, ver extension.ts) mais um
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
// REVISÃO 2026-08-02 (docs/DECISIONS.md, mesma data, "3ª rodada" seção 3):
// usuário reportou que o desenho original de M3.4 — backgroundColor laranja
// translúcido cobrindo do início ao fim do documento (isWholeLine) — "parece
// erro no módulo inteiro", não um aviso de lock de colaboração. Decisão
// confirmada com o usuário (pergunta direta, não uma leitura livre): REMOVER
// o overlay de fundo. O que sobrevive da decoração de editor:
//   - `rulerDecoration` (antes "overlayDecoration"): SÓ overviewRulerColor,
//     sem backgroundColor/isWholeLine — continua cobrindo o Range do
//     documento inteiro (o marcador na régua/minimap é proporcional a essa
//     range), mas sem pintar o texto. O hoverMessage fica anexado a essa
//     mesma range: como hoverMessage funciona independente de haver
//     background visível, o usuário ainda vê o aviso completo ao passar o
//     mouse em QUALQUER ponto do arquivo, só não há mais nenhuma cor de
//     fundo brigando com a sintaxe.
//   - `labelDecoration`: mantido como estava (rótulo "🔒 Bloqueado por X" no
//     fim da 1ª linha) — sem o fundo cobrindo tudo, deixa de parecer um erro
//     de lint no arquivo inteiro e passa a ler como um reforço pontual.
// Novo nesta revisão: `statusBarItem` (campo desta mesma classe, ver
// renderStatusBar()), item de status bar dedicado que mostra "$(lock) <nome>"
// só quando o arquivo ATIVO está sob lease alheia (oculto — `.hide()` — no
// caso contrário, nunca aparece vazio). Reaproveita a MESMA família de cor de
// aviso já adotada em StatusBarItem.ts
// (`new vscode.ThemeColor("statusBarItem.warningBackground")`, usada lá para
// o estado "no ar, aguardando plugin") em vez de inventar uma cor nova —
// mantém a linguagem visual de "atenção" consistente entre os dois avisos da
// barra de status.
//
// Limitação conhecida, documentada em vez de contornada com hack (pesquisa
// feita em M3.4, ver .claude/agent-memory/ui-dev.md; ainda fora de escopo
// nesta revisão, ver docs/DECISIONS.md 2026-08-02 seção 3): não existe
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
import { computeLeaseBorderState, buildLeaseStatusBarVisual, STRINGS } from "./leaseBorderState.js";

/** Lease tracker é recriado a cada conexão nova (ver SyncTeamService.onClientConnected) — por isso um getter, não um valor capturado na criação. */
export type GetLeaseTracker = () => LeaseTracker | null;
export type ResolveUuidForFsPath = (fsPath: string) => string | null;

// Laranja translúcido — mesma família de cor de "atenção/conectando" já
// adotada no painel do plugin (Theme.ConnectConnecting, ver
// .claude/agent-memory/ui-dev.md M4.5+) e no botão "waiting" da status bar
// (StatusBarItem.ts). Usado só na régua/minimap e no rótulo inline agora —
// não há mais background cobrindo o texto (ver revisão 2026-08-02 acima).
const WARNING_ACCENT = "rgba(224, 132, 32, 0.9)";
// Prioridade no grupo à direita da status bar — logo à direita do item de
// conexão (STATUS_BAR_PRIORITY=100 em StatusBarItem.ts; menor prioridade =
// mais à direita dentro do grupo), já que é uma informação mais específica
// (lease do arquivo ativo) do que o estado geral de conexão.
const LEASE_STATUS_BAR_PRIORITY = 99;

export class LeaseBorderDecoration implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  // Só overviewRulerColor — sem backgroundColor/isWholeLine desde a revisão
  // 2026-08-02 (ver comentário no topo do arquivo). Nome atualizado de
  // "overlayDecoration" para "rulerDecoration" porque não sobrepõe mais nada
  // visualmente sobre o texto, só marca a régua/minimap.
  private readonly rulerDecoration: vscode.TextEditorDecorationType;
  // Tipo separado (sem backgroundColor) só para o rótulo "after" — o texto
  // varia por dono, então não pode viver como opção fixa do tipo reciclado.
  private readonly labelDecoration: vscode.TextEditorDecorationType;
  // Item de status bar dedicado — mostra quem tem a lease do arquivo ATIVO
  // (diferente de rulerDecoration/labelDecoration, que se aplicam a todo
  // editor VISÍVEL). Ver renderStatusBar().
  private readonly statusBarItem: vscode.StatusBarItem;

  constructor(
    private readonly getLeaseTracker: GetLeaseTracker,
    private readonly resolveUuidForFsPath: ResolveUuidForFsPath,
  ) {
    this.rulerDecoration = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: WARNING_ACCENT,
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    });
    this.labelDecoration = vscode.window.createTextEditorDecorationType({});

    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, LEASE_STATUS_BAR_PRIORITY);
    this.statusBarItem.name = "SyncTeam: lease do arquivo ativo";

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
    this.renderStatusBar();
  }

  private renderEditor(editor: vscode.TextEditor): void {
    const uuid = this.resolveUuidForFsPath(editor.document.uri.fsPath);
    const state = computeLeaseBorderState(this.getLeaseTracker(), uuid);

    if (!state.locked) {
      // Sempre limpar os dois tipos — é assim que o VS Code remove
      // decorações antigas (substitui o conjunto inteiro daquele tipo).
      editor.setDecorations(this.rulerDecoration, []);
      editor.setDecorations(this.labelDecoration, []);
      return;
    }

    const owner = state.ownerName ?? STRINGS.fallbackOwnerName;
    const document = editor.document;
    const lastLine = document.lineCount - 1;
    const fullDocumentRange = new vscode.Range(0, 0, lastLine, document.lineAt(lastLine).text.length);

    // Sem backgroundColor: só a marca na régua/minimap. hoverMessage
    // continua funcionando em cima do documento inteiro (independe de haver
    // fundo visível), então passar o mouse em qualquer linha ainda mostra o
    // aviso completo.
    editor.setDecorations(this.rulerDecoration, [
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
   * Atualiza o item de status bar a partir só do editor ATIVO (diferente de
   * renderEditor, que roda para cada editor visível) — "quem é dono do
   * arquivo que estou vendo agora" é uma pergunta sobre um único arquivo por
   * vez. Reusa `computeLeaseBorderState`/`buildLeaseStatusBarVisual`
   * (nenhuma regra de negócio nova, só leitura do mesmo estado).
   */
  private renderStatusBar(): void {
    const editor = vscode.window.activeTextEditor;
    const uuid = editor ? this.resolveUuidForFsPath(editor.document.uri.fsPath) : null;
    const state = computeLeaseBorderState(this.getLeaseTracker(), uuid);
    const visual = buildLeaseStatusBarVisual(state);

    if (!visual.visible) {
      this.statusBarItem.hide();
      return;
    }

    this.statusBarItem.text = visual.text;
    this.statusBarItem.tooltip = visual.tooltip;
    // Mesma família de cor de "atenção" já usada em StatusBarItem.ts (estado
    // "no ar, aguardando plugin") — reaproveitada, não uma cor nova, para
    // manter os avisos da status bar visualmente consistentes.
    this.statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    this.statusBarItem.show();
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
    this.rulerDecoration.dispose();
    this.labelDecoration.dispose();
    this.statusBarItem.dispose();
  }
}
