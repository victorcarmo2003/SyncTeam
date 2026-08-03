import { describe, test, expect } from "vitest";
import { runExtensionInstall, type ExtensionInstallIO, type ExtensionInstallLogger } from "../src/commands/extensionInstall.js";

const FAKE_VSIX_BYTES = new Uint8Array([1, 2, 3, 4]);
const FAKE_TEMP_PATH = "/tmp/syncteam-12345.vsix";

function makeFakeIO(overrides: Partial<ExtensionInstallIO> = {}) {
  const state = {
    readCalls: 0,
    writeTempCalls: [] as Uint8Array[],
    removeCalls: [] as string[],
    runCodeInstallCalls: [] as string[],
  };
  const io: ExtensionInstallIO = {
    readEmbeddedExtension: async () => {
      state.readCalls++;
      return FAKE_VSIX_BYTES;
    },
    writeTempFile: async (data) => {
      state.writeTempCalls.push(data);
      return FAKE_TEMP_PATH;
    },
    removeFile: async (filePath) => {
      state.removeCalls.push(filePath);
    },
    runCodeInstall: async (vsixPath) => {
      state.runCodeInstallCalls.push(vsixPath);
      return { stdout: "Extension 'dev-hakor.syncteam' was successfully installed.", stderr: "" };
    },
    ...overrides,
  };
  return { io, state };
}

function makeFakeLogger() {
  const infoMessages: string[] = [];
  const errorMessages: string[] = [];
  const logger: ExtensionInstallLogger = {
    info: (msg) => infoMessages.push(msg),
    error: (msg) => errorMessages.push(msg),
  };
  return { logger, infoMessages, errorMessages };
}

describe("runExtensionInstall", () => {
  test("fluxo feliz: lê embutido, escreve temp, instala via code, remove temp, loga sucesso", async () => {
    const { io, state } = makeFakeIO();
    const { logger, infoMessages, errorMessages } = makeFakeLogger();

    const result = await runExtensionInstall(io, logger);

    expect(result).toEqual({ ok: true });
    expect(state.readCalls).toBe(1);
    expect(state.writeTempCalls).toEqual([FAKE_VSIX_BYTES]);
    expect(state.runCodeInstallCalls).toEqual([FAKE_TEMP_PATH]);
    expect(state.removeCalls).toEqual([FAKE_TEMP_PATH]);
    expect(errorMessages).toEqual([]);
    expect(infoMessages.some((m) => m.includes("successfully installed"))).toBe(true);
    expect(infoMessages.some((m) => m.includes("instalada"))).toBe(true);
  });

  test("readEmbeddedExtension falha: erro claro, nunca chama writeTempFile", async () => {
    const { io, state } = makeFakeIO({
      readEmbeddedExtension: async () => {
        throw new Error("asset corrompido");
      },
    });
    const { logger, errorMessages } = makeFakeLogger();

    const result = await runExtensionInstall(io, logger);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorMessage).toMatch(/asset corrompido/);
    expect(state.writeTempCalls).toEqual([]);
  });

  test("writeTempFile falha: erro claro, nunca chama runCodeInstall", async () => {
    const { io, state } = makeFakeIO({
      writeTempFile: async () => {
        throw new Error("disco cheio");
      },
    });
    const { logger, errorMessages } = makeFakeLogger();

    const result = await runExtensionInstall(io, logger);

    expect(result.ok).toBe(false);
    expect(state.runCodeInstallCalls).toEqual([]);
    expect(errorMessages.some((m) => m.includes("disco cheio"))).toBe(true);
  });

  test('"code" ausente no PATH (ENOENT): mensagem clara em vez de stack cru, ainda remove o arquivo temporário', async () => {
    const enoent = Object.assign(new Error("spawn code ENOENT"), { code: "ENOENT" });
    const { io, state } = makeFakeIO({
      runCodeInstall: async () => {
        throw enoent;
      },
    });
    const { logger, errorMessages } = makeFakeLogger();

    const result = await runExtensionInstall(io, logger);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toMatch(/não encontrado no PATH/);
      expect(result.errorMessage).not.toMatch(/ENOENT/); // mensagem amigável, não o código cru
    }
    expect(state.removeCalls).toEqual([FAKE_TEMP_PATH]); // best-effort cleanup mesmo em falha
  });

  test("code --install-extension falha por outro motivo: mensagem descritiva com o erro original", async () => {
    const { io } = makeFakeIO({
      runCodeInstall: async () => {
        throw new Error("extensão incompatível com esta versão do VS Code");
      },
    });
    const { logger, errorMessages } = makeFakeLogger();

    const result = await runExtensionInstall(io, logger);

    expect(result.ok).toBe(false);
    expect(errorMessages.some((m) => m.includes("extensão incompatível"))).toBe(true);
  });

  test("removeFile (limpeza do temp) falha: não é fatal, comando ainda reporta sucesso", async () => {
    const { io } = makeFakeIO({
      removeFile: async () => {
        throw new Error("arquivo temporário já removido por outro processo");
      },
    });
    const { logger, errorMessages } = makeFakeLogger();

    const result = await runExtensionInstall(io, logger);

    expect(result).toEqual({ ok: true });
    expect(errorMessages).toEqual([]); // best-effort silencioso, não polui o log de um comando bem-sucedido
  });
});
