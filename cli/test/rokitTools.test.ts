import { describe, test, expect } from "vitest";
import { compareVersions } from "../scripts/lib/rokitTools.js";

describe("compareVersions", () => {
  test("major/minor/patch numéricos simples", () => {
    expect(compareVersions("7.6.1", "7.7.0")).toBeLessThan(0);
    expect(compareVersions("7.7.0", "7.6.1")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  test("release conta como MAIOR que prerelease da mesma versão (caso real: rojo 7.7.0 vs 7.7.0-rc.1)", () => {
    expect(compareVersions("7.7.0-rc.1", "7.7.0")).toBeLessThan(0);
    expect(compareVersions("7.7.0", "7.7.0-rc.1")).toBeGreaterThan(0);
  });

  test("números de largura diferente (2 vs 3 componentes) não quebram", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
  });

  test("array ordenado por compareVersions coloca a versão mais alta por último (uso real: pegar tail)", () => {
    const versions = ["7.6.1", "7.7.0-rc.1", "7.7.0"];
    versions.sort(compareVersions);
    expect(versions[versions.length - 1]).toBe("7.7.0");
  });
});
