// SyncTeam — lógica PURA do widget da barra de status (barra inferior do VS
// Code). Este arquivo NÃO importa `vscode`: computa o texto/ícone/tooltip do
// item e a lista de opções do menu a partir do estado de conexão. Ficou
// separado de `StatusBarItem.ts` (que depende de `vscode`) para ser testável
// com vitest puro — importar `vscode` em qualquer arquivo tocado por um teste
// quebra o vitest (mesma disciplina de LeaseTracker/PresenceTracker; ver
// .claude/agent-memory/ui-dev.md e extension-dev.md).
//
// Todo texto visível ao usuário vive em STRINGS (pt-BR por padrão, público
// inicial), centralizado num único ponto para facilitar i18n futura — nenhum
// texto solto no StatusBarItem.ts.

/** Estado de conexão lido ao vivo pela camada de ativação (ver extension.ts). */
export interface ConnectionState {
  /** Servidor WebSocket local no ar (extensão ativa e ouvindo na porta). */
  running: boolean;
  /** Plugin do Studio conectado e com handshake (`hello`) concluído. */
  connected: boolean;
  /** Porta configurada em `syncteam.port`. */
  port: number;
}

/** Os três estados visuais distintos do item, na ordem de "menos pronto" -> "pronto". */
export type StatusVisualKind = "stopped" | "waiting" | "connected";

export interface StatusVisual {
  kind: StatusVisualKind;
  /** Texto do item, com codicon embutido (ex.: "$(circle-filled) SyncTeam :1400"). */
  text: string;
  tooltip: string;
  /**
   * Se true, a camada visual aplica `statusBarItem.warningBackground` — usado
   * só no estado "no ar, aguardando o plugin", para sinalizar "ainda não
   * totalmente conectado" num relance. Conectado e parado ficam sem fundo
   * (neutro), seguindo a convenção do VS Code de só colorir anomalias.
   */
  warning: boolean;
}

export interface StatusBarMenuOption {
  label: string;
  detail?: string;
  /** Id de comando VS Code a executar (contrato com extension-dev — não renomear). */
  command: string;
}

// Ids de comando — contrato combinado com o extension-dev (os comandos
// syncteam.start / syncteam.stop / syncteam.setPort são adicionados por ele; os
// demais já existem). NÃO renomear sem alinhar com ele.
export const COMMANDS = {
  start: "syncteam.start",
  stop: "syncteam.stop",
  setPort: "syncteam.setPort",
  refreshSync: "syncteam.refreshSync",
  showOutput: "syncteam.showOutput",
} as const;

const APP = "SyncTeam";

export const STRINGS = {
  menuPlaceholder: "SyncTeam — escolha uma ação",

  tooltipStopped: (port: number): string =>
    `SyncTeam parado (porta ${port}). Clique para ver as opções.`,
  tooltipWaiting: (port: number): string =>
    `SyncTeam no ar na porta ${port}, aguardando o plugin do Studio conectar. Clique para ver as opções.`,
  tooltipConnected: (port: number): string =>
    `SyncTeam conectado ao plugin do Studio (porta ${port}). Clique para ver as opções.`,

  menuStart: "$(play) Iniciar",
  menuStartDetail: "Sobe o servidor local e passa a aceitar o plugin do Studio",
  menuStop: "$(debug-stop) Parar",
  menuStopDetail: "Encerra o servidor local e desconecta o plugin do Studio",
  menuSetPort: "$(plug) Trocar porta",
  menuSetPortDetail: "Escolhe a porta local usada para conectar o plugin do Studio",
  menuRefresh: "$(sync) Refresh Sync",
  menuRefreshDetail: "Reconcilia disco e Studio agora (pega edições feitas com a extensão fechada)",
  menuShowOutput: "$(output) Mostrar log",
  menuShowOutputDetail: "Abre o canal de saída do SyncTeam",
} as const;

/**
 * Texto/ícone/tooltip do item da barra de status a partir do estado. Três
 * estados, do "menos pronto" para o "pronto":
 *
 * - parado          → `$(circle-outline)` (círculo vazado), neutro;
 * - no ar/aguardando → `$(broadcast)` (hospedando/ouvindo) + fundo de aviso;
 * - conectado        → `$(circle-filled)` (círculo cheio), neutro.
 *
 * A porta aparece sempre (inclusive parado), para o usuário saber qual porta
 * está/estará em uso.
 */
export function buildStatusVisual(state: ConnectionState): StatusVisual {
  const port = state.port;

  if (!state.running) {
    return {
      kind: "stopped",
      text: `$(circle-outline) ${APP} :${port}`,
      tooltip: STRINGS.tooltipStopped(port),
      warning: false,
    };
  }

  if (!state.connected) {
    return {
      kind: "waiting",
      text: `$(broadcast) ${APP} :${port}`,
      tooltip: STRINGS.tooltipWaiting(port),
      warning: true,
    };
  }

  return {
    kind: "connected",
    text: `$(circle-filled) ${APP} :${port}`,
    tooltip: STRINGS.tooltipConnected(port),
    warning: false,
  };
}

/**
 * Opções do menu (QuickPick) que o clique no item abre, filtradas pelo estado:
 *
 * - Iniciar / Parar: mutuamente exclusivos — só a ação relevante ao estado
 *   atual aparece (Iniciar só quando parado, Parar só quando rodando).
 * - Trocar porta: sempre (pode-se ajustar a porta inclusive antes de iniciar).
 * - Refresh Sync: só quando rodando E com plugin conectado — sem plugin a ação
 *   é inócua (o comando em si já recusa com aviso, mas não a oferecemos para
 *   não confundir).
 * - Mostrar log: sempre (útil inclusive parado, para entender o porquê).
 */
export function buildMenuOptions(state: ConnectionState): StatusBarMenuOption[] {
  const options: StatusBarMenuOption[] = [];

  if (state.running) {
    options.push({ label: STRINGS.menuStop, detail: STRINGS.menuStopDetail, command: COMMANDS.stop });
  } else {
    options.push({ label: STRINGS.menuStart, detail: STRINGS.menuStartDetail, command: COMMANDS.start });
  }

  options.push({ label: STRINGS.menuSetPort, detail: STRINGS.menuSetPortDetail, command: COMMANDS.setPort });

  if (state.running && state.connected) {
    options.push({ label: STRINGS.menuRefresh, detail: STRINGS.menuRefreshDetail, command: COMMANDS.refreshSync });
  }

  options.push({ label: STRINGS.menuShowOutput, detail: STRINGS.menuShowOutputDetail, command: COMMANDS.showOutput });

  return options;
}
