// Porte de spikes/m0_5-local-pipeline/harness/rojo-path-mapping.test.mjs
// (14 testes node:test) para vitest, cobrindo o módulo TypeScript portado em
// src/mapping/rojoPathMapping.ts. Mesmos casos, mesma cobertura.

import { describe, test, expect } from "vitest";
import { computeLayout, parseDiskPath, type LayoutInputEntry } from "../src/mapping/rojoPathMapping.js";

function assertRoundTrip(entries: LayoutInputEntry[]) {
  const classNameByPath = new Map(entries.map((e) => [e.path, e.className]));
  const layout = computeLayout(entries);
  for (const { instancePath, diskPath, isInit } of layout) {
    const parsed = parseDiskPath(diskPath);
    expect(parsed, `parseDiskPath('${diskPath}') não deveria ser null`).not.toBeNull();
    expect(parsed).toEqual({ instancePath, className: classNameByPath.get(instancePath), isInit });
  }
  return layout;
}

describe("computeLayout", () => {
  test("ModuleScript sem filhos vira arquivo plano .luau", () => {
    const layout = computeLayout([{ path: "Utils", className: "ModuleScript" }]);
    expect(layout).toEqual([{ instancePath: "Utils", diskPath: "Utils.luau", isInit: false }]);
  });

  test("Script sem filhos vira Nome.server.luau", () => {
    const layout = computeLayout([{ path: "Main", className: "Script" }]);
    expect(layout).toEqual([{ instancePath: "Main", diskPath: "Main.server.luau", isInit: false }]);
  });

  test("LocalScript sem filhos vira Nome.client.luau", () => {
    const layout = computeLayout([{ path: "Client", className: "LocalScript" }]);
    expect(layout).toEqual([{ instancePath: "Client", diskPath: "Client.client.luau", isInit: false }]);
  });

  test("ModuleScript com um filho direto vira pasta + init.luau", () => {
    const entries: LayoutInputEntry[] = [
      { path: "Lib", className: "ModuleScript" },
      { path: "Lib/Helper", className: "ModuleScript" },
    ];
    expect(computeLayout(entries)).toEqual([
      { instancePath: "Lib", diskPath: "Lib/init.luau", isInit: true },
      { instancePath: "Lib/Helper", diskPath: "Lib/Helper.luau", isInit: false },
    ]);
  });

  test("Script com um filho direto vira pasta + init.server.luau", () => {
    const entries: LayoutInputEntry[] = [
      { path: "Server", className: "Script" },
      { path: "Server/Sub", className: "ModuleScript" },
    ];
    expect(computeLayout(entries)).toEqual([
      { instancePath: "Server", diskPath: "Server/init.server.luau", isInit: true },
      { instancePath: "Server/Sub", diskPath: "Server/Sub.luau", isInit: false },
    ]);
  });

  test("LocalScript com um filho direto vira pasta + init.client.luau", () => {
    const entries: LayoutInputEntry[] = [
      { path: "Client", className: "LocalScript" },
      { path: "Client/Sub", className: "ModuleScript" },
    ];
    expect(computeLayout(entries)).toEqual([
      { instancePath: "Client", diskPath: "Client/init.client.luau", isInit: true },
      { instancePath: "Client/Sub", diskPath: "Client/Sub.luau", isInit: false },
    ]);
  });

  test("aninhamento de 3 níveis (todos ModuleScript)", () => {
    const entries: LayoutInputEntry[] = [
      { path: "A", className: "ModuleScript" },
      { path: "A/B", className: "ModuleScript" },
      { path: "A/B/C", className: "ModuleScript" },
    ];
    expect(computeLayout(entries)).toEqual([
      { instancePath: "A", diskPath: "A/init.luau", isInit: true },
      { instancePath: "A/B", diskPath: "A/B/init.luau", isInit: true },
      { instancePath: "A/B/C", diskPath: "A/B/C.luau", isInit: false },
    ]);
  });

  test("Script contendo ModuleScript filho, com pasta organizacional no meio (não é ela própria um entry)", () => {
    const entries: LayoutInputEntry[] = [
      { path: "Services/Main", className: "Script" },
      { path: "Services/Main/Config", className: "ModuleScript" },
    ];
    expect(computeLayout(entries)).toEqual([
      { instancePath: "Services/Main", diskPath: "Services/Main/init.server.luau", isInit: true },
      { instancePath: "Services/Main/Config", diskPath: "Services/Main/Config.luau", isInit: false },
    ]);
  });

  test("round-trip completo: flat, filho direto, 3 níveis, tipos mistos aninhados", () => {
    assertRoundTrip([
      { path: "Utils", className: "ModuleScript" },
      { path: "Main", className: "Script" },
      { path: "Client", className: "LocalScript" },
    ]);

    assertRoundTrip([
      { path: "Lib", className: "ModuleScript" },
      { path: "Lib/Helper", className: "ModuleScript" },
      { path: "Server", className: "Script" },
      { path: "Server/Sub", className: "ModuleScript" },
      { path: "Client", className: "LocalScript" },
      { path: "Client/Sub", className: "ModuleScript" },
    ]);

    assertRoundTrip([
      { path: "A", className: "ModuleScript" },
      { path: "A/B", className: "ModuleScript" },
      { path: "A/B/C", className: "ModuleScript" },
    ]);

    assertRoundTrip([
      { path: "Services/Main", className: "Script" },
      { path: "Services/Main/Config", className: "ModuleScript" },
    ]);
  });

  test("lança erro descritivo em colisão de diskPath (case-insensitive)", () => {
    const entries: LayoutInputEntry[] = [
      { path: "Foo", className: "ModuleScript" },
      { path: "foo", className: "ModuleScript" },
    ];
    expect(() => computeLayout(entries)).toThrowError(/colisão de diskPath/i);
  });

  test("lança erro descritivo em colisão de diskPath (init vs. arquivo achatado)", () => {
    const entries: LayoutInputEntry[] = [
      { path: "Parent", className: "ModuleScript" },
      { path: "Parent/Child", className: "ModuleScript" },
      { path: "Parent/init", className: "ModuleScript" },
    ];
    expect(() => computeLayout(entries)).toThrowError(/colisão de diskPath/i);
  });

  test("lança erro descritivo para className desconhecida", () => {
    expect(() => computeLayout([{ path: "Foo", className: "Frame" as never }])).toThrowError(/className desconhecida/i);
  });
});

describe("parseDiskPath", () => {
  test("aceita .lua como alternativa válida na leitura", () => {
    expect(parseDiskPath("Foo.lua")).toEqual({ instancePath: "Foo", className: "ModuleScript", isInit: false });
    expect(parseDiskPath("Foo.server.lua")).toEqual({ instancePath: "Foo", className: "Script", isInit: false });
    expect(parseDiskPath("Foo/init.client.lua")).toEqual({ instancePath: "Foo", className: "LocalScript", isInit: true });
  });

  test("retorna null para caminhos que não seguem a convenção", () => {
    expect(parseDiskPath("Foo.txt")).toBeNull();
    expect(parseDiskPath("Foo")).toBeNull();
    expect(parseDiskPath("init.luau")).toBeNull(); // init na raiz, sem pasta pai
    expect(parseDiskPath("")).toBeNull();
    expect(parseDiskPath(".luau")).toBeNull(); // nome-base vazio
  });
});
