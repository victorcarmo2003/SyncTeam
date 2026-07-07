import test from "node:test";
import assert from "node:assert/strict";
import { computeLayout, parseDiskPath } from "./rojo-path-mapping.mjs";

// Helper: roda computeLayout e confirma que parseDiskPath(diskPath) volta
// exatamente para {instancePath, className, isInit} de cada entry original —
// é o núcleo do que este módulo precisa garantir (ver tarefa: round-trip).
function assertRoundTrip(entries) {
  const classNameByPath = new Map(entries.map((e) => [e.path, e.className]));
  const layout = computeLayout(entries);
  for (const { instancePath, diskPath, isInit } of layout) {
    const parsed = parseDiskPath(diskPath);
    assert.notEqual(parsed, null, `parseDiskPath('${diskPath}') não deveria ser null`);
    assert.deepEqual(
      parsed,
      { instancePath, className: classNameByPath.get(instancePath), isInit },
      `round-trip falhou para '${instancePath}' (diskPath='${diskPath}')`
    );
  }
  return layout;
}

test("ModuleScript sem filhos vira arquivo plano .luau", () => {
  const layout = computeLayout([{ path: "Utils", className: "ModuleScript" }]);
  assert.deepEqual(layout, [{ instancePath: "Utils", diskPath: "Utils.luau", isInit: false }]);
});

test("Script sem filhos vira Nome.server.luau", () => {
  const layout = computeLayout([{ path: "Main", className: "Script" }]);
  assert.deepEqual(layout, [{ instancePath: "Main", diskPath: "Main.server.luau", isInit: false }]);
});

test("LocalScript sem filhos vira Nome.client.luau", () => {
  const layout = computeLayout([{ path: "Client", className: "LocalScript" }]);
  assert.deepEqual(layout, [{ instancePath: "Client", diskPath: "Client.client.luau", isInit: false }]);
});

test("ModuleScript com um filho direto vira pasta + init.luau", () => {
  const entries = [
    { path: "Lib", className: "ModuleScript" },
    { path: "Lib/Helper", className: "ModuleScript" },
  ];
  const layout = computeLayout(entries);
  assert.deepEqual(layout, [
    { instancePath: "Lib", diskPath: "Lib/init.luau", isInit: true },
    { instancePath: "Lib/Helper", diskPath: "Lib/Helper.luau", isInit: false },
  ]);
});

test("Script com um filho direto vira pasta + init.server.luau", () => {
  const entries = [
    { path: "Server", className: "Script" },
    { path: "Server/Sub", className: "ModuleScript" },
  ];
  const layout = computeLayout(entries);
  assert.deepEqual(layout, [
    { instancePath: "Server", diskPath: "Server/init.server.luau", isInit: true },
    { instancePath: "Server/Sub", diskPath: "Server/Sub.luau", isInit: false },
  ]);
});

test("LocalScript com um filho direto vira pasta + init.client.luau", () => {
  const entries = [
    { path: "Client", className: "LocalScript" },
    { path: "Client/Sub", className: "ModuleScript" },
  ];
  const layout = computeLayout(entries);
  assert.deepEqual(layout, [
    { instancePath: "Client", diskPath: "Client/init.client.luau", isInit: true },
    { instancePath: "Client/Sub", diskPath: "Client/Sub.luau", isInit: false },
  ]);
});

test("aninhamento de 3 níveis (todos ModuleScript)", () => {
  const entries = [
    { path: "A", className: "ModuleScript" },
    { path: "A/B", className: "ModuleScript" },
    { path: "A/B/C", className: "ModuleScript" },
  ];
  const layout = computeLayout(entries);
  assert.deepEqual(layout, [
    { instancePath: "A", diskPath: "A/init.luau", isInit: true },
    { instancePath: "A/B", diskPath: "A/B/init.luau", isInit: true },
    { instancePath: "A/B/C", diskPath: "A/B/C.luau", isInit: false },
  ]);
});

test("Script contendo ModuleScript filho, com pasta organizacional no meio (não é ela própria um entry)", () => {
  // "Services" nunca aparece como entry — é só uma pasta organizacional que
  // agrupa "Services/Main". O layout não deve tratá-la de forma especial.
  const entries = [
    { path: "Services/Main", className: "Script" },
    { path: "Services/Main/Config", className: "ModuleScript" },
  ];
  const layout = computeLayout(entries);
  assert.deepEqual(layout, [
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

test("computeLayout lança erro descritivo em colisão de diskPath (case-insensitive)", () => {
  const entries = [
    { path: "Foo", className: "ModuleScript" },
    { path: "foo", className: "ModuleScript" },
  ];
  assert.throws(() => computeLayout(entries), /colisão de diskPath/i);
});

test("computeLayout lança erro descritivo em colisão de diskPath (init vs. arquivo achatado)", () => {
  // "Parent" tem filho -> "Parent/init.luau". Um entry avulso cujo path
  // literal é "Parent/init" (ModuleScript sem filhos) colide no mesmo disco.
  const entries = [
    { path: "Parent", className: "ModuleScript" },
    { path: "Parent/Child", className: "ModuleScript" },
    { path: "Parent/init", className: "ModuleScript" },
  ];
  assert.throws(() => computeLayout(entries), /colisão de diskPath/i);
});

test("parseDiskPath aceita .lua como alternativa válida na leitura", () => {
  assert.deepEqual(parseDiskPath("Foo.lua"), {
    instancePath: "Foo",
    className: "ModuleScript",
    isInit: false,
  });
  assert.deepEqual(parseDiskPath("Foo.server.lua"), {
    instancePath: "Foo",
    className: "Script",
    isInit: false,
  });
  assert.deepEqual(parseDiskPath("Foo/init.client.lua"), {
    instancePath: "Foo",
    className: "LocalScript",
    isInit: true,
  });
});

test("parseDiskPath retorna null para caminhos que não seguem a convenção", () => {
  assert.equal(parseDiskPath("Foo.txt"), null);
  assert.equal(parseDiskPath("Foo"), null);
  assert.equal(parseDiskPath("init.luau"), null); // init na raiz, sem pasta pai
  assert.equal(parseDiskPath(""), null);
  assert.equal(parseDiskPath(".luau"), null); // nome-base vazio
});

test("computeLayout lança erro descritivo para className desconhecida", () => {
  assert.throws(
    () => computeLayout([{ path: "Foo", className: "Frame" }]),
    /className desconhecida/i
  );
});
