// Prompt Y/N real de terminal — implementação do `PortReclaimHost.confirmKill`
// (`vscode-extension/src/sync/PortOwnership.ts`, reusado sem alteração) para
// o CLI. A extensão VS Code implementa o MESMO contrato com um modal
// (`vscode.window.showWarningMessage`); aqui só a UI de confirmação muda —
// a lógica de detecção/decisão de porta é 100% a mesma, reusada por import
// cross-pacote (ver `commands/start.ts`).
//
// Disciplina de `.claude/rules/authority.md`: nunca mata processo de
// terceiro sem confirmação EXPLÍCITA a cada ocorrência — resposta
// vazia/Enter/Ctrl+D/qualquer coisa que não seja "s"/"sim"/"y"/"yes" conta
// como recusa (default seguro = NÃO matar).

import readline from "node:readline/promises";

export async function promptYesNo(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${message}\n[s/N] `)).trim().toLowerCase();
    return answer === "s" || answer === "sim" || answer === "y" || answer === "yes";
  } catch {
    // stdin fechado/não interativo (ex.: pipe sem TTY) — trata como recusa,
    // nunca como confirmação silenciosa.
    return false;
  } finally {
    rl.close();
  }
}
