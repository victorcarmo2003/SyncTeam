// Onde cai uma feature que nasceu no Studio e ainda nao existe no disco.
//
// Os pontos de montagem do ModuxTemplate sao reais: o rogen emite um POR
// FEATURE E LADO, e nenhum cobre `ServerScriptService/server` sozinho. E essa
// ausencia que faz uma feature nova nao ter destino, e e contra ela que o
// fallback e medido aqui.

import { describe, expect, it } from "vitest";
import {
  findUnbackedSides,
  parseLayoutDeclaration,
  resolveFallbackPlacement,
  type LayoutDeclaration,
} from "../src/mapping/layoutFallback.js";
import { computeFullLayout, type MountPoint } from "../src/mapping/projectMapping.js";

const DECLARACAO: LayoutDeclaration = {
  root: "src",
  sides: {
    client: "StarterPlayer/StarterPlayerScripts/client",
    server: "ServerScriptService/server",
    shared: "ReplicatedStorage/shared",
  },
};

// Recorte fiel do que o rogen gera: por feature e lado, nunca a raiz.
const MOUNTS: MountPoint[] = [
  { dataModelPath: "ServerScriptService/server/Vital", diskPath: "src/Vital/server" },
  { dataModelPath: "ServerScriptService/server/Round", diskPath: "src/Round/server" },
  { dataModelPath: "StarterPlayer/StarterPlayerScripts/client/Vital", diskPath: "src/Vital/client" },
];

describe("parseLayoutDeclaration", () => {
  it("projeto sem syncteam.json nao ganha fallback, e isso nao e erro", () => {
    expect(parseLayoutDeclaration({})).toBeNull();
    expect(parseLayoutDeclaration(null)).toBeNull();
  });

  it("declaracao quebrada erra alto em vez de virar ausente", () => {
    // Silenciar aqui devolveria o sintoma original: arquivo que nao chega ao
    // disco sem ninguem avisar, so que agora com o usuario ACHANDO que
    // configurou o fallback.
    expect(() => parseLayoutDeclaration({ layout: { root: "src" } })).toThrow(/sides/);
    expect(() => parseLayoutDeclaration({ layout: { sides: { server: "X" } } })).toThrow(/root/);
    expect(() => parseLayoutDeclaration({ layout: { root: "src", sides: {} } })).toThrow(/vazio/);
    expect(() => parseLayoutDeclaration({ layout: { root: "src", sides: { server: "" } } })).toThrow(/server/);
  });

  it("normaliza barra invertida e barra sobrando", () => {
    const d = parseLayoutDeclaration({ layout: { root: "/src/", sides: { server: "ServerScriptService\\server/" } } });
    expect(d).toEqual({ root: "src", sides: { server: "ServerScriptService/server" } });
  });
});

describe("resolveFallbackPlacement", () => {
  it("inverte lado e feature: no DataModel e lado/feature, no disco e feature/lado", () => {
    expect(resolveFallbackPlacement("ServerScriptService/server/NovaFeature/NovoService", DECLARACAO)).toEqual({
      featureDir: "src/NovaFeature/server",
      featureDataModelPath: "ServerScriptService/server/NovaFeature",
      relativeInstancePath: "NovoService",
      side: "server",
    });
  });

  it("preserva o caminho inteiro abaixo da feature", () => {
    const p = resolveFallbackPlacement("ReplicatedStorage/shared/Comum/Sub/Fundo", DECLARACAO);
    expect(p?.featureDir).toBe("src/Comum/shared");
    expect(p?.relativeInstancePath).toBe("Sub/Fundo");
  });

  it("casa o prefixo de lado mais LONGO", () => {
    // Com o prefixo curto vencendo, a feature nasceria um nivel acima e a
    // proxima passada do gerador a mapearia no lugar errado.
    const ambiguo: LayoutDeclaration = {
      root: "src",
      sides: { player: "StarterPlayer", client: "StarterPlayer/StarterPlayerScripts/client" },
    };
    const p = resolveFallbackPlacement("StarterPlayer/StarterPlayerScripts/client/Nova/Foo", ambiguo);
    expect(p?.side).toBe("client");
    expect(p?.featureDir).toBe("src/Nova/client");
  });

  it("lado desconhecido nao e colocado", () => {
    expect(resolveFallbackPlacement("Workspace/Coisa/Foo", DECLARACAO)).toBeNull();
  });

  it("so a pasta da feature, sem script dentro, nao e colocada", () => {
    // Criar pasta vazia nao ajudaria: o rogen so enxerga pasta que ja tem
    // `.luau` dentro, entao o mapeamento nao apareceria de qualquer forma.
    expect(resolveFallbackPlacement("ServerScriptService/server/NovaFeature", DECLARACAO)).toBeNull();
  });
});

describe("computeFullLayout com fallback", () => {
  it("sem declaracao, feature nova continua ignorada (comportamento antigo)", () => {
    const r = computeFullLayout(
      [{ path: "ServerScriptService/server/NovaFeature/NovoService", className: "ModuleScript" }],
      MOUNTS,
    );
    expect(r.layout).toHaveLength(0);
    expect(r.ignoredPaths).toEqual(["ServerScriptService/server/NovaFeature/NovoService"]);
    expect(r.placedByFallback).toEqual([]);
  });

  it("com declaracao, feature nova ganha destino em disco", () => {
    const r = computeFullLayout(
      [{ path: "ServerScriptService/server/NovaFeature/NovoService", className: "ModuleScript" }],
      MOUNTS,
      DECLARACAO,
    );
    expect(r.ignoredPaths).toEqual([]);
    expect(r.placedByFallback).toEqual(["src/NovaFeature/server"]);
    expect(r.layout).toEqual([
      {
        dataModelPath: "ServerScriptService/server/NovaFeature/NovoService",
        diskPath: "src/NovaFeature/server/NovoService.luau",
        isInit: false,
      },
    ]);
  });

  it("ponto de montagem de verdade ganha da declaracao", () => {
    // O fallback e ultimo recurso, nunca uma segunda fonte de verdade: se a
    // montagem existe, e ela que decide.
    const r = computeFullLayout(
      [{ path: "ServerScriptService/server/Vital/VitalService", className: "ModuleScript" }],
      MOUNTS,
      DECLARACAO,
    );
    expect(r.placedByFallback).toEqual([]);
    expect(r.layout[0]?.diskPath).toBe("src/Vital/server/VitalService.luau");
  });

  it("dois scripts da mesma feature nova caem na mesma pasta, e o pai vira init", () => {
    const r = computeFullLayout(
      [
        { path: "ServerScriptService/server/Nova/Mod", className: "ModuleScript" },
        { path: "ServerScriptService/server/Nova/Mod/Filho", className: "ModuleScript" },
      ],
      MOUNTS,
      DECLARACAO,
    );
    expect(r.placedByFallback).toEqual(["src/Nova/server"]);
    const porCaminho = Object.fromEntries(r.layout.map((e) => [e.dataModelPath, e.diskPath]));
    expect(porCaminho["ServerScriptService/server/Nova/Mod"]).toBe("src/Nova/server/Mod/init.luau");
    expect(porCaminho["ServerScriptService/server/Nova/Mod/Filho"]).toBe("src/Nova/server/Mod/Filho.luau");
  });
});

describe("findUnbackedSides", () => {
  it("nao reclama de lado que tem montagem de verdade", () => {
    expect(findUnbackedSides(DECLARACAO, MOUNTS.map((m) => m.dataModelPath))).toEqual(["shared"]);
  });

  it("acusa o lado inteiro quando a convencao mudou e a declaracao ficou para tras", () => {
    const desatualizada: LayoutDeclaration = { root: "src", sides: { server: "ServerStorage/server" } };
    expect(findUnbackedSides(desatualizada, MOUNTS.map((m) => m.dataModelPath))).toEqual(["server"]);
  });
});
