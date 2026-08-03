// Resolve como reinvocar o PRÓPRIO binário do CLI para spawnar o daemon
// destacado (`syncteam start` -> processo filho rodando `start
// --daemon-child`, ver `daemon/engine.ts`). Módulo puro/testável — recebe
// tudo injetado, não lê `process.*` diretamente.
//
// **Achado real desta tarefa, confirmado com um probe dedicado nesta
// máquina (`scripts/debug-argv-probe.ts`, rodado em modo interpretado E
// compilado — não documentado em `.claude/research/` antes, não uma
// suposição)**:
//
// | Campo                  | `bun run src/index.ts` (interpretado)        | binário compilado (`bun build --compile`)   |
// |-------------------------|-----------------------------------------------|------------------------------------------------|
// | `process.execPath`      | caminho REAL do `bun.exe`                     | caminho REAL do próprio executável compilado    |
// | `process.argv[0]`       | **igual a `execPath`** (caminho real do bun)  | **literal `"bun"`** (placeholder, não é um path)|
// | `process.argv[1]`       | caminho REAL do script (`src/index.ts`)       | caminho VIRTUAL dentro do bunfs (ex.:           |
// |                         |                                                 | `B:/~BUN/root/<nome>.exe`) — **NÃO é o 1º       |
// |                         |                                                 | argumento do usuário**                          |
//
// Duas tentativas anteriores nesta mesma tarefa (comparar `argv[1]` contra
// `import.meta.url`; depois checar `existsSync` desse caminho) FALHARAM na
// prática: os dois campos batem em AMBOS os modos (o caminho virtual do
// modo compilado é auto-referencial por construção), e `existsSync` também
// retorna `true` para o caminho virtual (o `fs` do Bun reconhece/virtualiza
// esses caminhos internos). Confirmado ao vivo: `syncteam.exe start`
// compilado, usando a heurística antiga, tentava reinvocar a si mesmo com
// `syncteam.exe "B:/~BUN/root/syncteam.exe" start --daemon-child` — um
// argumento a mais que o dispatcher do CLI não reconhecia.
//
// **Sinal que REALMENTE funciona**: comparar `process.execPath` contra
// `process.argv[0]` — batem apenas em modo interpretado (os dois são o
// mesmo `bun.exe`); no binário compilado, `argv[0]` é sempre a string
// literal `"bun"`, nunca um caminho real, e portanto nunca bate com
// `execPath`. Quando batem (interpretado), `argv[1]` é o script real e
// precisa ser repassado ao processo filho; quando não batem (compilado),
// nenhum argumento de caminho precisa ser repassado — só os argumentos
// extras importam, e `execPath` (não `argv[0]`, que é só o placeholder
// inútil `"bun"`) é o comando de verdade a spawnar.
//
// `[Verificado no Windows]` (bun 1.3.13) — `[Hipótese razoável, não testada]`
// em macOS/Linux (o mecanismo de compilação do Bun é o mesmo cross-platform,
// mas não foi exercitado fora desta máquina Windows).

import path from "node:path";

export interface SelfInvocationContext {
  /** `process.execPath` do processo atual — caminho REAL do executável em ambos os modos. */
  execPath: string;
  /** `process.argv[0]` do processo atual. */
  argv0: string;
  /** `process.argv[1]` do processo atual (pode ser `undefined` em alguns runtimes). */
  argv1: string | undefined;
}

export interface SelfInvocationCommand {
  command: string;
  args: string[];
}

export function resolveSelfInvocation(ctx: SelfInvocationContext, extraArgs: string[]): SelfInvocationCommand {
  const isInterpreted = path.resolve(ctx.execPath) === path.resolve(ctx.argv0);
  if (isInterpreted && ctx.argv1 !== undefined) {
    return { command: ctx.execPath, args: [ctx.argv1, ...extraArgs] };
  }
  return { command: ctx.execPath, args: [...extraArgs] };
}
