// Testa o PresenceTracker (M4): mapa de presença de colaboradores remotos,
// dedupe por clientId, resolução por uuid, cor estável por ordem de
// clientId, staleness (rede de segurança) e notificação de mudança.

import { describe, test, expect, vi } from "vitest";
import { PresenceTracker, getCollaboratorColor, PRESENCE_STALE_THRESHOLD_MS } from "../src/presence/PresenceTracker.js";

describe("PresenceTracker", () => {
  test("getAll começa vazio", () => {
    const tracker = new PresenceTracker();
    expect(tracker.getAll()).toEqual([]);
  });

  test("updatePresence cria uma entrada e dispara onDidChange", () => {
    const tracker = new PresenceTracker();
    const listener = vi.fn();
    tracker.onDidChange(listener);

    tracker.updatePresence("client-a", "Dev A", "uuid-1", 10, 5, null, null, 1000);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(tracker.getAll()).toEqual([
      {
        clientId: "client-a",
        displayName: "Dev A",
        uuid: "uuid-1",
        cursorLine: 10,
        cursorColumn: 5,
        selectionStartLine: null,
        selectionStartColumn: null,
        lastSeen: 1000,
      },
    ]);
  });

  test("updatePresence substitui a entrada existente do mesmo clientId (não duplica)", () => {
    const tracker = new PresenceTracker();
    tracker.updatePresence("client-a", "Dev A", "uuid-1", 10, 5, null, null, 1000);
    tracker.updatePresence("client-a", "Dev A", "uuid-2", 20, 0, null, null, 2000);

    expect(tracker.getAll()).toHaveLength(1);
    expect(tracker.getAll()[0].uuid).toBe("uuid-2");
  });

  test("removePresence remove e dispara onDidChange só se existia", () => {
    const tracker = new PresenceTracker();
    tracker.updatePresence("client-a", "Dev A", "uuid-1", 0, 0, null, null);
    const listener = vi.fn();
    tracker.onDidChange(listener);

    tracker.removePresence("client-a");
    expect(tracker.getAll()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);

    // Remover de novo (já não existe) não dispara change de novo.
    tracker.removePresence("client-a");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("clear remove tudo e dispara onDidChange só se havia algo", () => {
    const tracker = new PresenceTracker();
    tracker.updatePresence("client-a", "Dev A", "uuid-1", 0, 0, null, null);
    tracker.updatePresence("client-b", "Dev B", "uuid-2", 0, 0, null, null);

    const listener = vi.fn();
    tracker.onDidChange(listener);
    tracker.clear();

    expect(tracker.getAll()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);

    listener.mockClear();
    tracker.clear(); // já vazio
    expect(listener).not.toHaveBeenCalled();
  });

  test("getByUuid filtra corretamente, incluindo colaboradores sem script ativo (uuid null)", () => {
    const tracker = new PresenceTracker();
    tracker.updatePresence("client-a", "Dev A", "uuid-1", 0, 0, null, null);
    tracker.updatePresence("client-b", "Dev B", "uuid-1", 3, 1, null, null);
    tracker.updatePresence("client-c", "Dev C", null, null, null, null, null);
    tracker.updatePresence("client-d", "Dev D", "uuid-2", 0, 0, null, null);

    const inUuid1 = tracker.getByUuid("uuid-1");
    expect(inUuid1.map((c) => c.clientId).sort()).toEqual(["client-a", "client-b"]);

    // Nenhum colaborador tem uuid === null literalmente comparável via
    // getByUuid("uuid-2") — só confirma que filtro por uuid específico funciona.
    expect(tracker.getByUuid("uuid-2").map((c) => c.clientId)).toEqual(["client-d"]);
    expect(tracker.getByUuid("uuid-desconhecido")).toEqual([]);
  });

  test("getColorIndex é estável por ordem alfabética de clientId, não por ordem de chegada", () => {
    const tracker = new PresenceTracker();
    tracker.updatePresence("zzz-last", "Z", "uuid-1", 0, 0, null, null);
    tracker.updatePresence("aaa-first", "A", "uuid-1", 0, 0, null, null);

    expect(tracker.getColorIndex("aaa-first")).toBe(0);
    expect(tracker.getColorIndex("zzz-last")).toBe(1);
  });

  test("getColorIndex retorna 0 para clientId desconhecido (fallback seguro)", () => {
    const tracker = new PresenceTracker();
    expect(tracker.getColorIndex("nunca-visto")).toBe(0);
  });

  test("expireStale remove entradas mais velhas que o limiar e preserva as recentes", () => {
    const tracker = new PresenceTracker();
    tracker.updatePresence("client-old", "Old", "uuid-1", 0, 0, null, null, 0);
    tracker.updatePresence("client-fresh", "Fresh", "uuid-1", 0, 0, null, null, 9000);

    const listener = vi.fn();
    tracker.onDidChange(listener);

    // now = 10000, limiar = PRESENCE_STALE_THRESHOLD_MS (10000): client-old
    // (lastSeen=0) está exatamente no limiar -> expira; client-fresh
    // (lastSeen=9000, diff=1000) não expira.
    tracker.expireStale(10000, PRESENCE_STALE_THRESHOLD_MS);

    expect(tracker.getAll().map((c) => c.clientId)).toEqual(["client-fresh"]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("expireStale não dispara onDidChange quando nada expira", () => {
    const tracker = new PresenceTracker();
    tracker.updatePresence("client-a", "A", "uuid-1", 0, 0, null, null, 9999);
    const listener = vi.fn();
    tracker.onDidChange(listener);

    tracker.expireStale(10000, PRESENCE_STALE_THRESHOLD_MS);

    expect(tracker.getAll()).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
  });

  test("onDidChange retorna um objeto dispose() que para de notificar", () => {
    const tracker = new PresenceTracker();
    const listener = vi.fn();
    const subscription = tracker.onDidChange(listener);

    subscription.dispose();
    tracker.updatePresence("client-a", "A", "uuid-1", 0, 0, null, null);

    expect(listener).not.toHaveBeenCalled();
  });

  test("getCollaboratorColor cicla pela paleta de 8 cores", () => {
    const first = getCollaboratorColor(0);
    expect(getCollaboratorColor(8)).toBe(first);
    expect(typeof getCollaboratorColor(3)).toBe("string");
  });
});
