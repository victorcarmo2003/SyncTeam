import { describe, test, expect } from "vitest";
import { runPluginInstall, PLUGIN_FILE_NAME, type PluginInstallIO, type PluginInstallLogger } from "../src/commands/pluginInstall.js";
import type { PluginsDirContext } from "../src/plugin/studioPluginsDir.js";

const WIN_CTX: PluginsDirContext = {
  platform: "win32",
  homedir: "C:\\Users\\dev",
  env: { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
};

const EXPECTED_DEST = "C:\\Users\\dev\\AppData\\Local\\Roblox\\Plugins\\" + PLUGIN_FILE_NAME;

const FAKE_PLUGIN_BYTES = new Uint8Array([1, 2, 3, 4]);

function makeFakeIO(overrides: Partial<PluginInstallIO> = {}, existingFile = false) {
  const state = {
    mkdirCalls: [] as string[],
    removeCalls: [] as string[],
    writeCalls: [] as { path: string; data: Uint8Array }[],
    fileExists: existingFile,
  };

  const io: PluginInstallIO = {
    readEmbeddedPlugin: async () => FAKE_PLUGIN_BYTES,
    mkdir: async (dir) => {
      state.mkdirCalls.push(dir);
    },
    fileExists: async () => state.fileExists,
    removeFile: async (filePath) => {
      state.removeCalls.push(filePath);
      state.fileExists = false;
    },
    writeFile: async (filePath, data) => {
      state.writeCalls.push({ path: filePath, data });
    },
    ...overrides,
  };

  return { io, state };
}

function makeFakeLogger() {
  const infoMessages: string[] = [];
  const errorMessages: string[] = [];
  const logger: PluginInstallLogger = {
    info: (msg) => infoMessages.push(msg),
    error: (msg) => errorMessages.push(msg),
  };
  return { logger, infoMessages, errorMessages };
}

describe("runPluginInstall", () => {
  test("instalação nova (sem arquivo anterior): mkdir, sem remove, write, log de sucesso", async () => {
    const { io, state } = makeFakeIO({}, false);
    const { logger, infoMessages, errorMessages } = makeFakeLogger();

    const result = await runPluginInstall(WIN_CTX, io, logger);

    expect(result).toEqual({ ok: true, installedPath: EXPECTED_DEST });
    expect(state.mkdirCalls).toEqual(["C:\\Users\\dev\\AppData\\Local\\Roblox\\Plugins"]);
    expect(state.removeCalls).toEqual([]);
    expect(state.writeCalls).toEqual([{ path: EXPECTED_DEST, data: FAKE_PLUGIN_BYTES }]);
    expect(errorMessages).toEqual([]);
    expect(infoMessages).toEqual([`Plugin SyncTeam instalado em "${EXPECTED_DEST}".`]);
  });

  test("instalação sobre arquivo existente: delete+write (não overwrite in-place)", async () => {
    const { io, state } = makeFakeIO({}, true);
    const { logger, errorMessages } = makeFakeLogger();

    const result = await runPluginInstall(WIN_CTX, io, logger);

    expect(result.ok).toBe(true);
    expect(state.removeCalls).toEqual([EXPECTED_DEST]);
    expect(state.writeCalls).toHaveLength(1);
    expect(errorMessages).toEqual([]);
  });

  test("plataforma não suportada: não chama nenhuma IO, retorna erro claro", async () => {
    const { io, state } = makeFakeIO();
    const { logger, errorMessages } = makeFakeLogger();

    const result = await runPluginInstall({ platform: "linux", homedir: "/home/dev", env: {} }, io, logger);

    expect(result.ok).toBe(false);
    expect(state.mkdirCalls).toEqual([]);
    expect(state.writeCalls).toEqual([]);
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0]).toMatch(/não é suportada/);
  });

  test("mkdir falha: retorna erro descritivo, nunca chama write", async () => {
    const { io, state } = makeFakeIO({
      mkdir: async () => {
        throw new Error("EACCES: permission denied");
      },
    });
    const { logger, errorMessages } = makeFakeLogger();

    const result = await runPluginInstall(WIN_CTX, io, logger);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toMatch(/EACCES/);
    }
    expect(state.writeCalls).toEqual([]);
  });

  test("removeFile falha: não é fatal, segue para write mesmo assim", async () => {
    const { io, state } = makeFakeIO(
      {
        removeFile: async () => {
          throw new Error("locked by Studio");
        },
      },
      true,
    );
    const { logger, errorMessages, infoMessages } = makeFakeLogger();

    const result = await runPluginInstall(WIN_CTX, io, logger);

    expect(result.ok).toBe(true);
    expect(state.writeCalls).toHaveLength(1);
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0]).toMatch(/locked by Studio/);
    expect(infoMessages).toHaveLength(1);
  });

  test("readEmbeddedPlugin falha: retorna erro, nunca chama write", async () => {
    const { io, state } = makeFakeIO({
      readEmbeddedPlugin: async () => {
        throw new Error("arquivo embutido corrompido");
      },
    });
    const { logger, errorMessages } = makeFakeLogger();

    const result = await runPluginInstall(WIN_CTX, io, logger);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toMatch(/arquivo embutido corrompido/);
    }
    expect(state.writeCalls).toEqual([]);
  });

  test("writeFile falha: retorna erro descritivo", async () => {
    const { io } = makeFakeIO({
      writeFile: async () => {
        throw new Error("disco cheio");
      },
    });
    const { logger, errorMessages } = makeFakeLogger();

    const result = await runPluginInstall(WIN_CTX, io, logger);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toMatch(/disco cheio/);
    }
    expect(errorMessages.some((m) => m.includes("disco cheio"))).toBe(true);
  });

  test("erro não-Error (string/objeto cru) é convertido para mensagem legível, sem stack cru", async () => {
    const { io } = makeFakeIO({
      writeFile: async () => {
        throw "algo deu errado";
      },
    });
    const { logger, errorMessages } = makeFakeLogger();

    const result = await runPluginInstall(WIN_CTX, io, logger);

    expect(result.ok).toBe(false);
    expect(errorMessages.some((m) => m.includes("algo deu errado"))).toBe(true);
  });
});
