// SyncTeam — lógica PURA de decisão do aviso visual de "lease alheia" no editor
// (M3.4: metade do lease-UX que faltava do lado VS Code — o Studio já nega a
// escrita, mas o VS Code não avisava enquanto o usuário digitava). Este
// arquivo NÃO importa `vscode` — mesma disciplina de `statusBarMenu.ts` /
// `LeaseTracker.ts` (ver .claude/agent-memory/ui-dev.md), para ser testável
// com vitest puro; importar `vscode` em qualquer arquivo tocado por um teste
// quebra o vitest fora do Extension Host.
//
// Todo texto visível ao usuário vive em STRINGS (pt-BR por padrão, público
// inicial), centralizado num único ponto para facilitar i18n futura — nenhum
// texto solto em LeaseBorderDecoration.ts.

import type { LeaseTracker } from "../sync/LeaseTracker.js";

export interface LeaseBorderState {
  /** Deve mostrar o aviso visual (overlay + rótulo) neste editor. */
  locked: boolean;
  /** Nome de quem detém a lease. Só definido quando `locked` é true. */
  ownerName: string | null;
}

const NO_BORDER: LeaseBorderState = { locked: false, ownerName: null };

/**
 * Decide se o editor do arquivo (identificado por `uuid`) deve mostrar o
 * aviso de lease alheia.
 *
 * `leaseTracker === null` (nenhum `hello` recebido ainda, ou serviço
 * inativo) e `uuid === null` (arquivo fora do workspace de sync/não
 * reconhecido) são os dois casos "sem aviso" — mesma regra otimista que
 * `LeaseTracker.isOwnedByMe` já aplica para leases nunca arbitradas.
 */
export function computeLeaseBorderState(leaseTracker: LeaseTracker | null, uuid: string | null): LeaseBorderState {
  if (leaseTracker === null || uuid === null) {
    return NO_BORDER;
  }
  if (leaseTracker.isOwnedByMe(uuid)) {
    return NO_BORDER;
  }
  return { locked: true, ownerName: leaseTracker.describeOwner(uuid) };
}

export const STRINGS = {
  fallbackOwnerName: "outro colaborador",

  hoverMessage: (owner: string): string =>
    `SyncTeam: este arquivo está sob edição de **${owner}**. Suas alterações locais não serão sincronizadas ` +
    `enquanto a lease não for liberada (inatividade do outro lado) — edite com cuidado.`,

  labelText: (owner: string): string => `🔒 Bloqueado por ${owner}`,

  saveWarning: (owner: string, fileName: string): string =>
    `SyncTeam: '${fileName}' está bloqueado para edição por ${owner} — o Studio vai rejeitar esta alteração ` +
    `quando ela chegar lá.`,
} as const;
