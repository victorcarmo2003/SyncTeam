// Logger mínimo e sem dependência de VS Code, para a camada de lógica ser
// testável fora da extensão (ver .claude/rules/typescript.md). A camada de
// ativação (extension.ts) fornece uma implementação que também escreve num
// OutputChannel.

import fs from "node:fs";
import path from "node:path";

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

/**
 * Logger que grava (append-only) num arquivo em disco — pensado para um
 * harness Node de vida longa que o orquestrador (IA) possa ler depois com uma
 * ferramenta de leitura de arquivo, sem depender do usuário copiar/colar o
 * Output do Studio. Cria o diretório do arquivo se ainda não existir.
 *
 * Usa `fs.appendFileSync` (sem stream) deliberadamente: mais simples e à
 * prova de perda de linha em caso de crash do processo, ao custo de uma
 * syscall por linha — volume de log deste projeto não justifica otimizar
 * isso com um stream com buffer.
 *
 * `prefix` segue a mesma convenção de `createConsoleLogger`. Como um arquivo
 * de texto plano não tem cores/streams separados para distinguir nível (ao
 * contrário de console.log vs console.error), `warn`/`error` recebem uma tag
 * textual extra.
 */
export function createFileLogger(filePath: string, prefix = "[SyncTeam]"): Logger {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  function appendLine(level: string, message: string): void {
    fs.appendFileSync(filePath, `${prefix} ${timestamp()} ${level}${message}\n`, "utf8");
  }

  return {
    info(message: string): void {
      appendLine("", message);
    },
    warn(message: string): void {
      appendLine("WARN ", message);
    },
    error(message: string): void {
      appendLine("ERROR ", message);
    },
  };
}

/**
 * Despacha cada chamada para vários loggers ao mesmo tempo (ex.: manter o
 * log no console/stdout do harness E gravar em arquivo simultaneamente).
 */
export function createTeeLogger(...loggers: Logger[]): Logger {
  return {
    info(message: string): void {
      for (const logger of loggers) {
        logger.info(message);
      }
    },
    warn(message: string): void {
      for (const logger of loggers) {
        logger.warn(message);
      }
    },
    error(message: string): void {
      for (const logger of loggers) {
        logger.error(message);
      }
    },
  };
}
