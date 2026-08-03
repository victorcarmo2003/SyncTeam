import { describe, test, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readPidFile, writePidFile, removePidFile } from "../src/daemon/pidFile.js";

async function makeTmpPidFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "syncteam-cli-pidfile-"));
  return path.join(dir, "syncteam.pid");
}

describe("pidFile", () => {
  test("arquivo ausente: readPidFile devolve null", async () => {
    const pidFile = await makeTmpPidFile();
    expect(await readPidFile(pidFile)).toBeNull();
  });

  test("round-trip: escreve e lê de volta o mesmo valor", async () => {
    const pidFile = await makeTmpPidFile();
    await writePidFile(pidFile, { pid: 4321, port: 1400, projectDir: "/tmp/proj" });
    expect(await readPidFile(pidFile)).toEqual({ pid: 4321, port: 1400, projectDir: "/tmp/proj" });
  });

  test("JSON malformado: devolve null, nunca lança", async () => {
    const pidFile = await makeTmpPidFile();
    await fs.writeFile(pidFile, "{ não é json", "utf8");
    expect(await readPidFile(pidFile)).toBeNull();
  });

  test("formato inesperado (campo faltando/tipo errado): devolve null", async () => {
    const pidFile = await makeTmpPidFile();
    await fs.writeFile(pidFile, JSON.stringify({ pid: "não é número", port: 1400, projectDir: "/tmp" }), "utf8");
    expect(await readPidFile(pidFile)).toBeNull();

    await fs.writeFile(pidFile, JSON.stringify({ pid: 1, port: 1400 }), "utf8"); // projectDir ausente
    expect(await readPidFile(pidFile)).toBeNull();
  });

  test("removePidFile: idempotente (ENOENT não lança), remove de fato quando existe", async () => {
    const pidFile = await makeTmpPidFile();
    await expect(removePidFile(pidFile)).resolves.toBeUndefined(); // já ausente — não lança

    await writePidFile(pidFile, { pid: 1, port: 1400, projectDir: "/tmp" });
    await removePidFile(pidFile);
    expect(await readPidFile(pidFile)).toBeNull();
    await expect(fs.access(pidFile)).rejects.toThrow();
  });
});
