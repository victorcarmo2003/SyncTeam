import { describe, test, expect } from "vitest";
import path from "node:path";
import { resolveSyncteamPaths } from "../src/config/paths.js";

describe("resolveSyncteamPaths", () => {
  test("deriva todos os caminhos a partir de homedir, sob ~/.syncteam", () => {
    const paths = resolveSyncteamPaths("/home/dev");
    expect(paths.configDir).toBe(path.join("/home/dev", ".syncteam"));
  });

  test("todos os arquivos/pastas vivem dentro de configDir", () => {
    const paths = resolveSyncteamPaths("/home/dev");
    for (const file of [paths.configFile, paths.pidFile, paths.daemonLogFile, paths.portLockDir]) {
      expect(file.startsWith(paths.configDir)).toBe(true);
    }
  });

  test("nomes de arquivo/pasta esperados", () => {
    const paths = resolveSyncteamPaths("/home/dev");
    expect(paths.configFile.endsWith("config.json")).toBe(true);
    expect(paths.pidFile.endsWith("syncteam.pid")).toBe(true);
    expect(paths.daemonLogFile.endsWith("daemon.log")).toBe(true);
    expect(paths.portLockDir.endsWith("port-locks")).toBe(true);
  });
});
