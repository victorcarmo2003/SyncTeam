// Testa o LeaseTracker (M3.3): rastreamento de donos de leases e determinação
// de quem pode editar cada script.

import { describe, test, expect } from "vitest";
import { LeaseTracker } from "../src/sync/LeaseTracker.js";

describe("LeaseTracker", () => {
  test("permite edição otimista quando nenhuma lease foi arbitrada ainda", () => {
    const tracker = new LeaseTracker("my-client-id");

    // Nenhuma lease arbitrada ainda → permitir.
    expect(tracker.isOwnedByMe("some-uuid")).toBe(true);
    expect(tracker.describeOwner("some-uuid")).toBeNull();
  });

  test("permite edição quando a lease é minha", () => {
    const tracker = new LeaseTracker("my-client-id");

    tracker.updateLease("uuid-1", "my-client-id", "My Name");

    expect(tracker.isOwnedByMe("uuid-1")).toBe(true);
    expect(tracker.describeOwner("uuid-1")).toBeNull(); // é meu, não precisa descrição
  });

  test("nega edição quando a lease é de outro", () => {
    const tracker = new LeaseTracker("my-client-id");

    tracker.updateLease("uuid-1", "other-client-id", "Other Name");

    expect(tracker.isOwnedByMe("uuid-1")).toBe(false);
    expect(tracker.describeOwner("uuid-1")).toBe("Other Name");
  });

  test("permite edição quando a lease foi liberada (null)", () => {
    const tracker = new LeaseTracker("my-client-id");

    tracker.updateLease("uuid-1", null, null);

    expect(tracker.isOwnedByMe("uuid-1")).toBe(true);
    expect(tracker.describeOwner("uuid-1")).toBeNull();
  });

  test("retorna clientId como fallback se displayName não for fornecido", () => {
    const tracker = new LeaseTracker("my-client-id");

    tracker.updateLease("uuid-1", "other-client-id", null);

    expect(tracker.isOwnedByMe("uuid-1")).toBe(false);
    expect(tracker.describeOwner("uuid-1")).toBe("cliente other-client-id");
  });

  test("atualiza lease quando novo leaseChanged chega", () => {
    const tracker = new LeaseTracker("my-client-id");

    tracker.updateLease("uuid-1", "owner-a", "Owner A");
    expect(tracker.isOwnedByMe("uuid-1")).toBe(false);

    // Owner muda para outro.
    tracker.updateLease("uuid-1", "owner-b", "Owner B");
    expect(tracker.describeOwner("uuid-1")).toBe("Owner B");

    // Lease é liberada.
    tracker.updateLease("uuid-1", null, null);
    expect(tracker.isOwnedByMe("uuid-1")).toBe(true);
  });

  test("trabalha com clientId null (sem coordenação M3.1 ainda)", () => {
    const tracker = new LeaseTracker(null);

    tracker.updateLease("uuid-1", null, null);
    expect(tracker.isOwnedByMe("uuid-1")).toBe(true);

    // Alguém adquire a lease — não é meu porque meu id é null.
    tracker.updateLease("uuid-1", "someone", "Someone");
    expect(tracker.isOwnedByMe("uuid-1")).toBe(false);
  });

  test("getLease retorna o estado bruto de uma lease", () => {
    const tracker = new LeaseTracker("my-client-id");

    tracker.updateLease("uuid-1", "owner", "Owner Name");

    const lease = tracker.getLease("uuid-1");
    expect(lease).toEqual({ ownerClientId: "owner", ownerDisplayName: "Owner Name" });
  });

  test("getLease retorna undefined para uuid desconhecido", () => {
    const tracker = new LeaseTracker("my-client-id");

    expect(tracker.getLease("unknown-uuid")).toBeUndefined();
  });
});
