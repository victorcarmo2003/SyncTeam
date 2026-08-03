import { describe, test, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readCliConfig, writeCliConfig, DEFAULT_PORT } from "../src/config/cliConfig.js";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "syncteam-cli-config-"));
}

describe("readCliConfig / writeCliConfig", () => {
  test("arquivo ausente: devolve o default", async () => {
    const dir = await makeTmpDir();
    const config = await readCliConfig(path.join(dir, "config.json"));
    expect(config).toEqual({ port: DEFAULT_PORT });
  });

  test("round-trip: escreve e lê de volta o mesmo valor", async () => {
    const dir = await makeTmpDir();
    const configDir = path.join(dir, "nested"); // testa mkdir recursivo
    const configFile = path.join(configDir, "config.json");

    await writeCliConfig(configDir, configFile, { port: 5555 });
    const config = await readCliConfig(configFile);

    expect(config).toEqual({ port: 5555 });
  });

  test("JSON malformado: degrada para o default, nunca lança", async () => {
    const dir = await makeTmpDir();
    const configFile = path.join(dir, "config.json");
    await fs.writeFile(configFile, "{ isso não é json", "utf8");

    const config = await readCliConfig(configFile);
    expect(config).toEqual({ port: DEFAULT_PORT });
  });

  test("campo port inválido (fora do intervalo/não numérico): degrada para o default", async () => {
    const dir = await makeTmpDir();
    const configFile = path.join(dir, "config.json");
    await fs.writeFile(configFile, JSON.stringify({ port: "abacate" }), "utf8");

    const config = await readCliConfig(configFile);
    expect(config).toEqual({ port: DEFAULT_PORT });
  });

  test("port ausente no JSON: degrada para o default", async () => {
    const dir = await makeTmpDir();
    const configFile = path.join(dir, "config.json");
    await fs.writeFile(configFile, JSON.stringify({}), "utf8");

    const config = await readCliConfig(configFile);
    expect(config).toEqual({ port: DEFAULT_PORT });
  });
});
