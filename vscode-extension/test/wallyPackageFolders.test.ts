// Testa o módulo puro de convenção de nomes de pastas de pacotes Wally
// (Packages/ServerPackages/DevPackages) — sem I/O, sem vscode. Ver
// docs/DECISIONS.md 2026-07-16.

import { describe, test, expect } from "vitest";
import { isExcludedPackageFolderName, isInsideExcludedPackageFolder } from "../src/mapping/wallyPackageFolders.js";

describe("isExcludedPackageFolderName", () => {
  test.each(["Packages", "ServerPackages", "DevPackages"])("'%s' é reconhecido", (name) => {
    expect(isExcludedPackageFolderName(name)).toBe(true);
  });

  test("nome case-sensitive diferente não conta ('packages' minúsculo)", () => {
    expect(isExcludedPackageFolderName("packages")).toBe(false);
  });

  test("nome que só contém a palavra como substring não conta", () => {
    expect(isExcludedPackageFolderName("MyPackagesFolder")).toBe(false);
  });

  test("nome não relacionado não conta", () => {
    expect(isExcludedPackageFolderName("Server")).toBe(false);
  });
});

describe("isInsideExcludedPackageFolder", () => {
  test("segmento 'Packages' em qualquer posição do path conta", () => {
    expect(isInsideExcludedPackageFolder("Packages/Foo/Bar")).toBe(true);
    expect(isInsideExcludedPackageFolder("ServerScriptService/Packages/Foo")).toBe(true);
    expect(isInsideExcludedPackageFolder("src/Packages")).toBe(true);
  });

  test("segmento 'ServerPackages' conta", () => {
    expect(isInsideExcludedPackageFolder("ServerPackages/X")).toBe(true);
  });

  test("segmento 'DevPackages' conta", () => {
    expect(isInsideExcludedPackageFolder("ServerScriptService/DevPackages/Y/Z")).toBe(true);
  });

  test("path sem nenhum segmento excluído não conta", () => {
    expect(isInsideExcludedPackageFolder("ServerScriptService/Server/Main")).toBe(false);
  });

  test("nome de segmento que só contém a palavra como substring NÃO conta (não é substring match)", () => {
    expect(isInsideExcludedPackageFolder("MyPackagesFolder/Foo")).toBe(false);
    expect(isInsideExcludedPackageFolder("Foo/MyPackagesFolder")).toBe(false);
  });

  test("path vazio ou não-string não conta", () => {
    expect(isInsideExcludedPackageFolder("")).toBe(false);
  });

  test("funciona também para diskPath (mesmo formato, extensão no segmento final)", () => {
    expect(isInsideExcludedPackageFolder("Packages/Foo/Bar.luau")).toBe(true);
    expect(isInsideExcludedPackageFolder("Packages/init.luau")).toBe(true);
  });
});
