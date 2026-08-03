import { describe, test, expect } from "vitest";
import { resolveSelfInvocation } from "../src/daemon/selfInvocation.js";

describe("resolveSelfInvocation", () => {
  test("modo interpretado (argv0 == execPath, ambos o bun.exe real): repete argv1 (caminho do script) antes dos args extras", () => {
    const result = resolveSelfInvocation(
      { execPath: "/usr/bin/bun", argv0: "/usr/bin/bun", argv1: "/repo/cli/src/index.ts" },
      ["start", "--daemon-child"],
    );
    expect(result).toEqual({ command: "/usr/bin/bun", args: ["/repo/cli/src/index.ts", "start", "--daemon-child"] });
  });

  test('modo binário compilado (argv0 é o placeholder literal "bun", diferente de execPath — achado real desta tarefa): só os args extras, sem repetir nenhum caminho', () => {
    // Achado real (ver comentário de selfInvocation.ts, confirmado com
    // scripts/debug-argv-probe.ts nesta máquina): no binário compilado,
    // process.argv[0] é sempre a string literal "bun" (nunca um caminho
    // real), enquanto process.execPath é o caminho real do executável — os
    // dois NUNCA batem nesse modo, ao contrário do modo interpretado.
    const result = resolveSelfInvocation(
      { execPath: "C:\\caminho\\real\\syncteam.exe", argv0: "bun", argv1: "B:/~BUN/root/syncteam.exe" },
      ["start", "--daemon-child"],
    );
    expect(result).toEqual({ command: "C:\\caminho\\real\\syncteam.exe", args: ["start", "--daemon-child"] });
  });

  test("argv0 ausente (string vazia): tratado como binário compilado (nunca bate com execPath)", () => {
    const result = resolveSelfInvocation({ execPath: "/usr/local/bin/syncteam", argv0: "", argv1: undefined }, ["start", "--daemon-child"]);
    expect(result).toEqual({ command: "/usr/local/bin/syncteam", args: ["start", "--daemon-child"] });
  });

  test("modo interpretado mas argv1 ausente (runtime atípico): não repete nada, só os args extras", () => {
    const result = resolveSelfInvocation({ execPath: "/usr/bin/bun", argv0: "/usr/bin/bun", argv1: undefined }, ["start", "--daemon-child"]);
    expect(result).toEqual({ command: "/usr/bin/bun", args: ["start", "--daemon-child"] });
  });

  test("normaliza caminhos equivalentes (ex.: segmentos '..') antes de comparar execPath/argv0", () => {
    const result = resolveSelfInvocation(
      { execPath: "/usr/bin/bun", argv0: "/usr/bin/../bin/bun", argv1: "/repo/cli/src/index.ts" },
      ["start", "--daemon-child"],
    );
    expect(result).toEqual({ command: "/usr/bin/bun", args: ["/repo/cli/src/index.ts", "start", "--daemon-child"] });
  });
});
