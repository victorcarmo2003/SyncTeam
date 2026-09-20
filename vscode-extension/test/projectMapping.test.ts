// Testa o parser de default.project.json (pontos de montagem $path) e a
// composição com o mapeador Rojo, nos dois sentidos (DataModel -> disco e
// disco -> DataModel). Usa como fixture o mesmo formato de
// spikes/m1-test-project/default.project.json (ver instruções da tarefa).

import { describe, test, expect } from "vitest";
import {
  parseMountPoints,
  resolveMountForDataModelPath,
  resolveMountForDiskPath,
  computeFullLayout,
  resolveDataModelPathForDiskChange,
  computeWatchedRoots,
  type MountPoint,
} from "../src/mapping/projectMapping.js";

const M1_TEST_PROJECT = {
  name: "SyncTeamM1TestProject",
  tree: {
    $className: "DataModel",
    ReplicatedStorage: {
      Shared: { $path: "src/shared" },
    },
    ServerScriptService: {
      Server: { $path: "src/server" },
    },
    StarterPlayer: {
      StarterPlayerScripts: {
        Client: { $path: "src/client" },
      },
    },
  },
};

describe("parseMountPoints", () => {
  test("extrai os 3 pontos de montagem do projeto de teste do M1", () => {
    const mountPoints = parseMountPoints(M1_TEST_PROJECT);
    expect(mountPoints).toEqual(
      expect.arrayContaining([
        { dataModelPath: "ReplicatedStorage/Shared", diskPath: "src/shared" },
        { dataModelPath: "ServerScriptService/Server", diskPath: "src/server" },
        { dataModelPath: "StarterPlayer/StarterPlayerScripts/Client", diskPath: "src/client" },
      ]),
    );
    expect(mountPoints).toHaveLength(3);
  });

  test("normaliza barras invertidas e barra final no $path", () => {
    const mountPoints = parseMountPoints({
      tree: { ServerScriptService: { Server: { $path: "src\\server\\" } } },
    });
    expect(mountPoints).toEqual([{ dataModelPath: "ServerScriptService/Server", diskPath: "src/server" }]);
  });

  test("ignora chaves $ e nós sem $path", () => {
    const mountPoints = parseMountPoints({
      tree: { $className: "DataModel", Workspace: { $className: "Workspace" } },
    });
    expect(mountPoints).toEqual([]);
  });

  test("lança erro descritivo se 'tree' estiver ausente", () => {
    expect(() => parseMountPoints({ name: "Foo" })).toThrowError(/tree/i);
  });

  test("lança erro descritivo se o projeto não for um objeto", () => {
    expect(() => parseMountPoints(null)).toThrowError();
    expect(() => parseMountPoints("nope")).toThrowError();
  });
});

describe("resolveMountForDataModelPath", () => {
  const mountPoints = parseMountPoints(M1_TEST_PROJECT);

  test("acha o mount e o path relativo para um script dentro dele", () => {
    expect(resolveMountForDataModelPath("ServerScriptService/Server/Foo/Bar", mountPoints)).toEqual({
      mount: { dataModelPath: "ServerScriptService/Server", diskPath: "src/server" },
      relativeInstancePath: "Foo/Bar",
    });
  });

  test("relativeInstancePath vazio quando o path é exatamente a raiz do mount", () => {
    expect(resolveMountForDataModelPath("ServerScriptService/Server", mountPoints)).toEqual({
      mount: { dataModelPath: "ServerScriptService/Server", diskPath: "src/server" },
      relativeInstancePath: "",
    });
  });

  test("retorna null para path fora de qualquer ponto de montagem", () => {
    expect(resolveMountForDataModelPath("Workspace/SomeThing", mountPoints)).toBeNull();
    // Prefixo textual mas não prefixo de segmento (ex.: "ServerScriptService2") não deve casar.
    expect(resolveMountForDataModelPath("ServerScriptService2/Foo", mountPoints)).toBeNull();
  });

  test("escolhe o mount mais específico em pontos de montagem aninhados", () => {
    const nested: MountPoint[] = [
      { dataModelPath: "ReplicatedStorage", diskPath: "src/shared-root" },
      { dataModelPath: "ReplicatedStorage/Shared", diskPath: "src/shared" },
    ];
    expect(resolveMountForDataModelPath("ReplicatedStorage/Shared/Foo", nested)).toEqual({
      mount: { dataModelPath: "ReplicatedStorage/Shared", diskPath: "src/shared" },
      relativeInstancePath: "Foo",
    });
  });
});

describe("resolveMountForDiskPath", () => {
  const mountPoints = parseMountPoints(M1_TEST_PROJECT);

  test("acha o mount e o path relativo, comparação case-insensitive", () => {
    expect(resolveMountForDiskPath("SRC/Server/Foo.luau", mountPoints)).toEqual({
      mount: { dataModelPath: "ServerScriptService/Server", diskPath: "src/server" },
      relativeDiskPath: "Foo.luau",
    });
  });

  test("retorna null para disco fora de qualquer ponto de montagem", () => {
    expect(resolveMountForDiskPath("README.md", mountPoints)).toBeNull();
  });
});

describe("computeFullLayout (DataModel -> disco)", () => {
  const mountPoints = parseMountPoints(M1_TEST_PROJECT);

  test("compõe mount + rojoPathMapping para entries em mounts diferentes", () => {
    const result = computeFullLayout(
      [
        { path: "ServerScriptService/Server/Main", className: "Script" },
        { path: "ServerScriptService/Server/Utils", className: "ModuleScript" },
        { path: "StarterPlayer/StarterPlayerScripts/Client/Init", className: "LocalScript" },
        { path: "ReplicatedStorage/Shared/Hello", className: "ModuleScript" },
      ],
      mountPoints,
    );
    expect(result.ignoredPaths).toEqual([]);
    expect(result.layout).toEqual(
      expect.arrayContaining([
        {
          dataModelPath: "ServerScriptService/Server/Main",
          diskPath: "src/server/Main.server.luau",
          isInit: false,
        },
        {
          dataModelPath: "ServerScriptService/Server/Utils",
          diskPath: "src/server/Utils.luau",
          isInit: false,
        },
        {
          dataModelPath: "StarterPlayer/StarterPlayerScripts/Client/Init",
          diskPath: "src/client/Init.client.luau",
          isInit: false,
        },
        {
          dataModelPath: "ReplicatedStorage/Shared/Hello",
          diskPath: "src/shared/Hello.luau",
          isInit: false,
        },
      ]),
    );
  });

  test("script com filhos vira pasta + init dentro do mount correto", () => {
    const result = computeFullLayout(
      [
        { path: "ServerScriptService/Server/Lib", className: "ModuleScript" },
        { path: "ServerScriptService/Server/Lib/Helper", className: "ModuleScript" },
      ],
      mountPoints,
    );
    expect(result.layout).toEqual([
      { dataModelPath: "ServerScriptService/Server/Lib", diskPath: "src/server/Lib/init.luau", isInit: true },
      { dataModelPath: "ServerScriptService/Server/Lib/Helper", diskPath: "src/server/Lib/Helper.luau", isInit: false },
    ]);
  });

  test("path fora de qualquer mount vai para ignoredPaths (informativo, sem erro)", () => {
    const result = computeFullLayout(
      [
        { path: "ServerScriptService/Server/Main", className: "Script" },
        { path: "Workspace/SomethingElse", className: "Script" },
      ],
      mountPoints,
    );
    expect(result.ignoredPaths).toEqual(["Workspace/SomethingElse"]);
    expect(result.layout).toEqual([
      { dataModelPath: "ServerScriptService/Server/Main", diskPath: "src/server/Main.server.luau", isInit: false },
    ]);
  });

  test("propaga erro de colisão de diskPath dentro do mesmo mount", () => {
    expect(() =>
      computeFullLayout(
        [
          { path: "ServerScriptService/Server/Foo", className: "ModuleScript" },
          { path: "ServerScriptService/Server/foo", className: "ModuleScript" },
        ],
        mountPoints,
      ),
    ).toThrowError(/colisão de diskPath/i);
  });
});

describe("computeWatchedRoots", () => {
  test("extrai o serviço de topo (primeiro segmento) de cada mount, sem duplicata", () => {
    const mountPoints = parseMountPoints(M1_TEST_PROJECT);
    // M1_TEST_PROJECT tem 3 mounts, cada um sob um serviço de topo distinto.
    expect(computeWatchedRoots(mountPoints)).toEqual(["ReplicatedStorage", "ServerScriptService", "StarterPlayer"]);
  });

  test("deduplica quando 2+ mounts caem sob o MESMO serviço de topo", () => {
    const mountPoints: MountPoint[] = [
      { dataModelPath: "ReplicatedStorage/Shared", diskPath: "src/shared" },
      { dataModelPath: "ReplicatedStorage/Vendor", diskPath: "src/vendor" },
      { dataModelPath: "ServerScriptService/Server", diskPath: "src/server" },
    ];
    expect(computeWatchedRoots(mountPoints)).toEqual(["ReplicatedStorage", "ServerScriptService"]);
  });

  test("mount cujo dataModelPath é a raiz do serviço (sem sub-segmento) conta como esse serviço", () => {
    const mountPoints: MountPoint[] = [{ dataModelPath: "ReplicatedFirst", diskPath: "src/first" }];
    expect(computeWatchedRoots(mountPoints)).toEqual(["ReplicatedFirst"]);
  });

  test("preserva a ordem de primeira aparição em mountPoints (não ordena alfabeticamente)", () => {
    const mountPoints: MountPoint[] = [
      { dataModelPath: "StarterPlayer/StarterPlayerScripts/Client", diskPath: "src/client" },
      { dataModelPath: "ReplicatedStorage/Shared", diskPath: "src/shared" },
      { dataModelPath: "ServerScriptService/Server", diskPath: "src/server" },
    ];
    expect(computeWatchedRoots(mountPoints)).toEqual(["StarterPlayer", "ReplicatedStorage", "ServerScriptService"]);
  });

  test("lista vazia de mount points devolve lista vazia", () => {
    expect(computeWatchedRoots([])).toEqual([]);
  });

  test("bug real 2026-07-29: mount point novo sob serviço fora da lista fixa do plugin (ReplicatedFirst) aparece normalmente", () => {
    const mountPoints = parseMountPoints({
      tree: {
        ReplicatedFirst: { First: { $path: "src/first" } },
        ServerScriptService: { Server: { $path: "src/server" } },
      },
    });
    expect(computeWatchedRoots(mountPoints)).toEqual(expect.arrayContaining(["ReplicatedFirst", "ServerScriptService"]));
  });
});

describe("resolveDataModelPathForDiskChange (disco -> DataModel)", () => {
  const mountPoints = parseMountPoints(M1_TEST_PROJECT);

  test("resolve um arquivo achatado dentro de um mount", () => {
    expect(resolveDataModelPathForDiskChange("src/server/Main.server.luau", mountPoints)).toEqual({
      dataModelPath: "ServerScriptService/Server/Main",
      className: "Script",
      isInit: false,
    });
  });

  test("resolve um init.*.luau dentro de uma pasta", () => {
    expect(resolveDataModelPathForDiskChange("src/client/Foo/init.client.luau", mountPoints)).toEqual({
      dataModelPath: "StarterPlayer/StarterPlayerScripts/Client/Foo",
      className: "LocalScript",
      isInit: true,
    });
  });

  test("retorna null para arquivo fora de qualquer mount", () => {
    expect(resolveDataModelPathForDiskChange("README.md", mountPoints)).toBeNull();
  });

  test("retorna null para arquivo dentro de um mount mas que não segue a convenção Rojo", () => {
    expect(resolveDataModelPathForDiskChange("src/server/notes.txt", mountPoints)).toBeNull();
  });

  test("init.*.luau na raiz exata de um mount nomeado resolve pro próprio mount (bug real, projeto Towers)", () => {
    const mounts: MountPoint[] = [
      { dataModelPath: "ServerScriptService/Server", diskPath: "src/server" },
      { dataModelPath: "StarterPlayer/StarterPlayerScripts/Client", diskPath: "src/client" },
    ];
    expect(resolveDataModelPathForDiskChange("src/server/init.server.luau", mounts)).toEqual({
      dataModelPath: "ServerScriptService/Server",
      className: "Script",
      isInit: true,
    });
    expect(resolveDataModelPathForDiskChange("src/client/init.client.luau", mounts)).toEqual({
      dataModelPath: "StarterPlayer/StarterPlayerScripts/Client",
      className: "LocalScript",
      isInit: true,
    });
  });

  test("round-trip: computeFullLayout -> resolveDataModelPathForDiskChange volta ao original", () => {
    const entries = [
      { path: "ServerScriptService/Server/Main", className: "Script" as const },
      { path: "ServerScriptService/Server/Lib", className: "ModuleScript" as const },
      { path: "ServerScriptService/Server/Lib/Helper", className: "ModuleScript" as const },
    ];
    const { layout } = computeFullLayout(entries, mountPoints);
    for (const item of layout) {
      const resolved = resolveDataModelPathForDiskChange(item.diskPath, mountPoints);
      expect(resolved).not.toBeNull();
      expect(resolved?.dataModelPath).toBe(item.dataModelPath);
      expect(resolved?.isInit).toBe(item.isInit);
    }
  });
});

describe("parseMountPoints — $path na forma opcional do Rojo", () => {
  // O rogen emite TODO mount de código como `{ optional: ... }`. Antes de
  // 2026-09-20 isso era pulado em silêncio, e num projeto Modux o SyncTeam
  // lia 3 mounts de 23 — sincronizava os Packages e nada do src/.
  test("lê `{ optional }` igual a uma string", () => {
    const mounts = parseMountPoints({
      tree: {
        ServerScriptService: {
          server: {
            Vital: { $path: { optional: "src/Vital/server" } },
            Round: { $path: "src/Round/server" },
          },
        },
      },
    });
    expect(mounts).toEqual([
      { dataModelPath: "ServerScriptService/server/Vital", diskPath: "src/Vital/server" },
      { dataModelPath: "ServerScriptService/server/Round", diskPath: "src/Round/server" },
    ]);
  });

  test("normaliza igual nas duas formas", () => {
    const mounts = parseMountPoints({
      tree: { A: { $path: { optional: "src\\a\\" } }, B: { $path: "src\\a\\" } },
    });
    expect(mounts[0]?.diskPath).toBe("src/a");
    expect(mounts[1]?.diskPath).toBe("src/a");
  });

  test("ignora forma que não traz caminho utilizável", () => {
    const mounts = parseMountPoints({
      tree: {
        Vazio: { $path: { optional: "" } },
        Errado: { $path: { caminho: "src/x" } },
        Lista: { $path: ["src/x"] },
        SoAgrupa: { Filho: { $path: "src/f" } },
      },
    });
    expect(mounts).toEqual([{ dataModelPath: "SoAgrupa/Filho", diskPath: "src/f" }]);
  });
});
