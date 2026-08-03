import { describe, test, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runPortCommand } from "../src/commands/port.js";
import type { PortCommandLogger } from "../src/commands/port.js";

function makeLogger(): { logger: PortCommandLogger; info: string[]; error: string[] } {
  const info: string[] = [];
  const error: string[] = [];
  return { logger: { info: (m) => info.push(m), error: (m) => error.push(m) }, info, error };
}

async function makeTmpConfigPaths(): Promise<{ configDir: string; configFile: string }> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "syncteam-cli-port-"));
  return { configDir, configFile: path.join(configDir, "config.json") };
}

describe("runPortCommand", () => {
  test("porta válida: persiste no config.json e loga sucesso", async () => {
    const { configDir, configFile } = await makeTmpConfigPaths();
    const { logger, info, error } = makeLogger();

    const result = await runPortCommand("5555", configDir, configFile, logger);

    expect(result).toEqual({ ok: true, port: 5555 });
    expect(error).toEqual([]);
    expect(info).toHaveLength(1);

    const written = JSON.parse(await fs.readFile(configFile, "utf8"));
    expect(written).toEqual({ port: 5555 });
  });

  test("porta ausente (undefined): erro claro, nada escrito", async () => {
    const { configDir, configFile } = await makeTmpConfigPaths();
    const { logger, error } = makeLogger();

    const result = await runPortCommand(undefined, configDir, configFile, logger);

    expect(result.ok).toBe(false);
    expect(error).toHaveLength(1);
    expect(error[0]).toMatch(/Porta inválida/);
    await expect(fs.access(configFile)).rejects.toThrow();
  });

  test("porta não numérica: erro claro", async () => {
    const { configDir, configFile } = await makeTmpConfigPaths();
    const { logger, error } = makeLogger();

    const result = await runPortCommand("abacate", configDir, configFile, logger);

    expect(result.ok).toBe(false);
    expect(error[0]).toMatch(/Porta inválida/);
  });

  test("porta fora do intervalo (0, negativo, > 65535): erro claro", async () => {
    const { configDir, configFile } = await makeTmpConfigPaths();
    const { logger } = makeLogger();

    for (const raw of ["0", "-1", "70000", "1.5"]) {
      const result = await runPortCommand(raw, configDir, configFile, logger);
      expect(result.ok, `esperava falha para "${raw}"`).toBe(false);
    }
  });

  test("segunda chamada sobrescreve a porta anterior", async () => {
    const { configDir, configFile } = await makeTmpConfigPaths();
    const { logger } = makeLogger();

    await runPortCommand("1400", configDir, configFile, logger);
    await runPortCommand("1401", configDir, configFile, logger);

    const written = JSON.parse(await fs.readFile(configFile, "utf8"));
    expect(written).toEqual({ port: 1401 });
  });
});
