// Logger mínimo e sem dependência de VS Code, para a camada de lógica ser
// testável fora da extensão (ver .claude/rules/typescript.md). A camada de
// ativação (extension.ts) fornece uma implementação que também escreve num
// OutputChannel.

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

function timestamp(): string {
  return new Date().toISOString();
}

/** Logger de console com prefixo `[SyncTeam]` (regra de .claude/rules/luau.md, reaproveitada aqui). */
export function createConsoleLogger(prefix = "[SyncTeam]"): Logger {
  return {
    info(message: string): void {
      console.log(`${prefix} ${timestamp()} ${message}`);
    },
    warn(message: string): void {
      console.warn(`${prefix} ${timestamp()} ${message}`);
    },
    error(message: string): void {
      console.error(`${prefix} ${timestamp()} ${message}`);
    },
  };
}

/** Logger que não escreve nada — útil em testes para silenciar saída esperada (ex.: casos de erro). */
export function createNullLogger(): Logger {
  return {
    info(): void {},
    warn(): void {},
    error(): void {},
  };
}
