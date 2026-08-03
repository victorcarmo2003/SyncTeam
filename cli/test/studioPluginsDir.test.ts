import { describe, test, expect } from "vitest";
import { resolveStudioPluginsDir, UnsupportedPlatformError } from "../src/plugin/studioPluginsDir.js";

describe("resolveStudioPluginsDir", () => {
  test("Windows: usa LOCALAPPDATA quando presente no env", () => {
    const dir = resolveStudioPluginsDir({
      platform: "win32",
      homedir: "C:\\Users\\dev",
      env: { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
    });
    expect(dir).toBe("C:\\Users\\dev\\AppData\\Local\\Roblox\\Plugins");
  });

  test("Windows: cai para homedir\\AppData\\Local quando LOCALAPPDATA ausente", () => {
    const dir = resolveStudioPluginsDir({
      platform: "win32",
      homedir: "C:\\Users\\dev",
      env: {},
    });
    expect(dir).toBe("C:\\Users\\dev\\AppData\\Local\\Roblox\\Plugins");
  });

  test("macOS: ~/Documents/Roblox/Plugins", () => {
    const dir = resolveStudioPluginsDir({
      platform: "darwin",
      homedir: "/Users/dev",
      env: {},
    });
    expect(dir).toBe("/Users/dev/Documents/Roblox/Plugins");
  });

  test("Linux: não suportado, lança UnsupportedPlatformError", () => {
    expect(() =>
      resolveStudioPluginsDir({ platform: "linux", homedir: "/home/dev", env: {} }),
    ).toThrow(UnsupportedPlatformError);
  });

  test("plataforma desconhecida também lança UnsupportedPlatformError", () => {
    expect(() =>
      resolveStudioPluginsDir({ platform: "aix", homedir: "/home/dev", env: {} }),
    ).toThrow(UnsupportedPlatformError);
  });
});
