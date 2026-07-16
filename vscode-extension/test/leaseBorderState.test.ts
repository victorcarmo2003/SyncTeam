// Testa a lógica PURA de decisão do aviso de lease alheia no editor (M3.4).
// Ver src/ui/leaseBorderState.ts — não importa `vscode`.

import { describe, test, expect } from "vitest";
import { computeLeaseBorderState, STRINGS } from "../src/ui/leaseBorderState.js";
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
