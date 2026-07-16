// Testa o PresencePublisher (M4): dedupe por payload idêntico, publishClear,
// resetDedupe. Transporte fake que só captura o que foi enviado — sem
// WebSocket, sem VS Code.

import { describe, test, expect } from "vitest";
import { PresencePublisher, type PresenceTransport, type PresenceUpdatePayload } from "../src/presence/PresencePublisher.js";

class FakeTransport implements PresenceTransport {
  readonly sent: PresenceUpdatePayload[] = [];
  sendPresenceUpdate(payload: PresenceUpdatePayload): void {
    this.sent.push(payload);
  }
}

describe("PresencePublisher", () => {
  test("publish envia o primeiro payload", () => {
    const transport = new FakeTransport();
    const publisher = new PresencePublisher(transport);

    publisher.publish({ uuid: "uuid-1", cursorLine: 1, cursorColumn: 2, selectionStartLine: null, selectionStartColumn: null });

    expect(transport.sent).toEqual([
      { uuid: "uuid-1", cursorLine: 1, cursorColumn: 2, selectionStartLine: null, selectionStartColumn: null },
    ]);
  });

  test("publish não reenvia payload idêntico ao último (dedupe)", () => {
    const transport = new FakeTransport();
    const publisher = new PresencePublisher(transport);
    const payload: PresenceUpdatePayload = { uuid: "uuid-1", cursorLine: 1, cursorColumn: 2, selectionStartLine: null, selectionStartColumn: null };

    publisher.publish(payload);
    publisher.publish({ ...payload }); // objeto diferente, conteúdo igual
    publisher.publish({ ...payload });

    expect(transport.sent).toHaveLength(1);
  });

  test("publish reenvia quando o payload muda", () => {
    const transport = new FakeTransport();
    const publisher = new PresencePublisher(transport);

    publisher.publish({ uuid: "uuid-1", cursorLine: 1, cursorColumn: 2, selectionStartLine: null, selectionStartColumn: null });
    publisher.publish({ uuid: "uuid-1", cursorLine: 1, cursorColumn: 3, selectionStartLine: null, selectionStartColumn: null });

    expect(transport.sent).toHaveLength(2);
  });

  test("publishClear envia payload com uuid null e todos os campos null", () => {
    const transport = new FakeTransport();
    const publisher = new PresencePublisher(transport);

    publisher.publish({ uuid: "uuid-1", cursorLine: 1, cursorColumn: 2, selectionStartLine: null, selectionStartColumn: null });
    publisher.publishClear();

    expect(transport.sent).toEqual([
      { uuid: "uuid-1", cursorLine: 1, cursorColumn: 2, selectionStartLine: null, selectionStartColumn: null },
      { uuid: null, cursorLine: null, cursorColumn: null, selectionStartLine: null, selectionStartColumn: null },
    ]);
  });

  test("publishClear duas vezes seguidas só envia uma vez (dedupe também vale para o payload vazio)", () => {
    const transport = new FakeTransport();
    const publisher = new PresencePublisher(transport);

    publisher.publishClear();
    publisher.publishClear();

    expect(transport.sent).toHaveLength(1);
  });

  test("resetDedupe força o próximo publish a ser enviado mesmo que idêntico ao último", () => {
    const transport = new FakeTransport();
    const publisher = new PresencePublisher(transport);
    const payload: PresenceUpdatePayload = { uuid: "uuid-1", cursorLine: 1, cursorColumn: 2, selectionStartLine: null, selectionStartColumn: null };

    publisher.publish(payload);
    publisher.resetDedupe();
    publisher.publish(payload);

    expect(transport.sent).toHaveLength(2);
  });

  test("publish distingue seleção presente de ausente mesmo com mesmo cursor", () => {
    const transport = new FakeTransport();
    const publisher = new PresencePublisher(transport);

    publisher.publish({ uuid: "uuid-1", cursorLine: 5, cursorColumn: 5, selectionStartLine: null, selectionStartColumn: null });
    publisher.publish({ uuid: "uuid-1", cursorLine: 5, cursorColumn: 5, selectionStartLine: 1, selectionStartColumn: 0 });

    expect(transport.sent).toHaveLength(2);
  });
});
