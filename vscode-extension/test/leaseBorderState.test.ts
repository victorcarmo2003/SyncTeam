// Testa a lógica PURA de decisão do aviso de lease alheia no editor (M3.4).
// Ver src/ui/leaseBorderState.ts — não importa `vscode`.

import { describe, test, expect } from "vitest";
import { computeLeaseBorderState, buildLeaseStatusBarVisual, STRINGS } from "../src/ui/leaseBorderState.js";
import { LeaseTracker } from "../src/sync/LeaseTracker.js";

describe("computeLeaseBorderState", () => {
  test("sem leaseTracker (serviço inativo/sem hello ainda): nunca bloqueia", () => {
    expect(computeLeaseBorderState(null, "uuid-1")).toEqual({ locked: false, ownerName: null });
  });

  test("sem uuid (arquivo fora do workspace de sync/não reconhecido): nunca bloqueia", () => {
    const tracker = new LeaseTracker("my-client-id");
    tracker.updateLease("uuid-1", "other-client-id", "Other Name");
    expect(computeLeaseBorderState(tracker, null)).toEqual({ locked: false, ownerName: null });
  });

  test("lease nunca arbitrada: otimista, não bloqueia (mesma regra do LeaseTracker)", () => {
    const tracker = new LeaseTracker("my-client-id");
    expect(computeLeaseBorderState(tracker, "uuid-1")).toEqual({ locked: false, ownerName: null });
  });

  test("lease é minha: não bloqueia", () => {
    const tracker = new LeaseTracker("my-client-id");
    tracker.updateLease("uuid-1", "my-client-id", "Eu Mesmo");
    expect(computeLeaseBorderState(tracker, "uuid-1")).toEqual({ locked: false, ownerName: null });
  });

  test("lease livre (liberada): não bloqueia", () => {
    const tracker = new LeaseTracker("my-client-id");
    tracker.updateLease("uuid-1", null, null);
    expect(computeLeaseBorderState(tracker, "uuid-1")).toEqual({ locked: false, ownerName: null });
  });

  test("lease de outro colaborador: bloqueia e expõe o nome do dono", () => {
    const tracker = new LeaseTracker("my-client-id");
    tracker.updateLease("uuid-1", "other-client-id", "Other Name");
    expect(computeLeaseBorderState(tracker, "uuid-1")).toEqual({ locked: true, ownerName: "Other Name" });
  });

  test("lease de outro colaborador sem displayName: usa fallback do clientId (via LeaseTracker.describeOwner)", () => {
    const tracker = new LeaseTracker("my-client-id");
    tracker.updateLease("uuid-1", "other-client-id", null);
    expect(computeLeaseBorderState(tracker, "uuid-1")).toEqual({ locked: true, ownerName: "cliente other-client-id" });
  });
});

describe("STRINGS (leaseBorderState)", () => {
  test("hoverMessage, labelText e saveWarning incluem o nome do dono", () => {
    expect(STRINGS.hoverMessage("Alice")).toContain("Alice");
    expect(STRINGS.labelText("Alice")).toContain("Alice");
    expect(STRINGS.saveWarning("Alice", "Foo.luau")).toContain("Alice");
    expect(STRINGS.saveWarning("Alice", "Foo.luau")).toContain("Foo.luau");
  });

  test("fallbackOwnerName existe para quando describeOwner não tem nome", () => {
    expect(STRINGS.fallbackOwnerName.length).toBeGreaterThan(0);
  });
});

// Revisão 2026-08-02 (docs/DECISIONS.md, "3ª rodada" seção 3): item de status
// bar novo que substitui o overlay de fundo removido de LeaseBorderDecoration.
describe("buildLeaseStatusBarVisual", () => {
  test("sem lock (locked: false): item fica oculto, sem texto/tooltip", () => {
    const visual = buildLeaseStatusBarVisual({ locked: false, ownerName: null });
    expect(visual.visible).toBe(false);
    expect(visual.text).toBe("");
    expect(visual.tooltip).toBe("");
  });

  test("com lock: visível, texto com codicon $(lock) e nome do dono", () => {
    const visual = buildLeaseStatusBarVisual({ locked: true, ownerName: "Alice" });
    expect(visual.visible).toBe(true);
    expect(visual.text).toContain("$(lock)");
    expect(visual.text).toContain("Alice");
    expect(visual.tooltip).toContain("Alice");
  });

  test("com lock sem ownerName: usa fallbackOwnerName", () => {
    const visual = buildLeaseStatusBarVisual({ locked: true, ownerName: null });
    expect(visual.text).toContain(STRINGS.fallbackOwnerName);
    expect(visual.tooltip).toContain(STRINGS.fallbackOwnerName);
  });
});
