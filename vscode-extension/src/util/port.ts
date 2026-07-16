// SyncTeam — validação da porta configurável (syncteam.port / comando
// syncteam.setPort). Módulo puro, sem `vscode`: a mesma lógica serve tanto
// para o guard do controlador (parsePortInput) quanto para o validateInput do
// showInputBox (validatePortInput), garantindo que os dois nunca divirjam.

/** Menor porta aceitável (evita 0 = "qualquer porta", que não é o que o usuário quer configurar). */
export const MIN_PORT = 1;
/** Maior porta válida em TCP/IP — acima disso o bind sempre falharia. */
export const MAX_PORT = 65535;

/**
 * Interpreta a entrada crua do usuário (do showInputBox) como uma porta
 * válida — inteiro em [MIN_PORT, MAX_PORT] — ou retorna `null` quando a
 * entrada é cancelada (`undefined`/`null`), vazia, ou não é um inteiro
 * positivo dentro do intervalo. Nunca lança.
 *
 * Só aceita dígitos (`^\d+$` após trim): rejeita sinal negativo, decimais,
 * espaços internos e qualquer caractere não numérico. `null` é o sinal
 * canônico de "não faça nada" que o comando setPort usa.
 */
export function parsePortInput(input: string | undefined | null): number | null {
  if (input === undefined || input === null) {
    return null; // cancelado (Escape no showInputBox)
  }
  const trimmed = input.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < MIN_PORT || value > MAX_PORT) {
    return null;
  }
  return value;
}

/**
 * Mensagem de erro para o `validateInput` do `vscode.window.showInputBox`
 * (retorna `undefined` quando a entrada é válida, permitindo o submit). Como
 * delega a decisão para `parsePortInput`, o feedback inline do input box e o
 * guard do comando concordam por construção.
 */
export function validatePortInput(input: string): string | undefined {
  if (parsePortInput(input) === null) {
    return `Porta inválida: digite um número inteiro entre ${MIN_PORT} e ${MAX_PORT}.`;
  }
  return undefined;
}
