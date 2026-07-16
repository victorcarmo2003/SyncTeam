// Testa a lógica PURA do widget da barra de status: qual visual (ícone/texto/
// tooltip/aviso) e quais opções de menu para cada estado de conexão. Sem
// `vscode` (arquivo puro), roda no vitest normal.

import { describe, test, expect } from "vitest";
import {
  buildMenuOptions,
  buildStatusVisual,
  COMMANDS,
  type ConnectionState,
} from "../src/ui/statusBarMenu.js";

const stopped: ConnectionState = { running: false, connected: false, port: 1400 };
const waiting: ConnectionState = { running: true, connected: false, port: 1400 };
const connected: ConnectionState = { running: true, connected: true, port: 1400 };

function commandsOf(state: ConnectionState): string[] {
  return buildMenuOptions(state).map((option) => option.command);
}

describe("buildStatusVisual", () => {
  test("parado: círculo vazado, sem aviso, porta no texto", () => {
    const visual = buildStatusVisual(stopped);
    expect(visual.kind).toBe("stopped");
    expect(visual.text).toContain("$(circle-outline)");
    expect(visual.text).toContain(":1400");
    expect(visual.warning).toBe(false);
  });

  test("rodando sem plugin: broadcast + fundo de aviso", () => {
    const visual = buildStatusVisual(waiting);
    expect(visual.kind).toBe("waiting");
    expect(visual.text).toContain("$(broadcast)");
    expect(visual.warning).toBe(true);
  });

  test("conectado: círculo cheio, sem aviso", () => {
    const visual = buildStatusVisual(connected);
    expect(visual.kind).toBe("connected");
    expect(visual.text).toContain("$(circle-filled)");
    expect(visual.warning).toBe(false);
  });

  test("a porta configurada aparece sempre no texto", () => {
    const visual = buildStatusVisual({ running: true, connected: true, port: 2222 });
    expect(visual.text).toContain(":2222");
  });
});

describe("buildMenuOptions", () => {
  test("parado: oferece Iniciar, nunca Parar", () => {
    const commands = commandsOf(stopped);
    expect(commands).toContain(COMMANDS.start);
    expect(commands).not.toContain(COMMANDS.stop);
  });

  test("rodando: oferece Parar, nunca Iniciar", () => {
    expect(commandsOf(waiting)).toContain(COMMANDS.stop);
    expect(commandsOf(waiting)).not.toContain(COMMANDS.start);
    expect(commandsOf(connected)).toContain(COMMANDS.stop);
    expect(commandsOf(connected)).not.toContain(COMMANDS.start);
  });

  test("Iniciar e Parar são mutuamente exclusivos em todos os estados", () => {
    for (const state of [stopped, waiting, connected]) {
      const commands = commandsOf(state);
      const hasStart = commands.includes(COMMANDS.start);
      const hasStop = commands.includes(COMMANDS.stop);
      expect(hasStart).not.toBe(hasStop);
    }
  });

  test("Refresh Sync só aparece quando rodando E conectado", () => {
    expect(commandsOf(stopped)).not.toContain(COMMANDS.refreshSync);
    expect(commandsOf(waiting)).not.toContain(COMMANDS.refreshSync);
    expect(commandsOf(connected)).toContain(COMMANDS.refreshSync);
  });

  test("Trocar porta e Mostrar log aparecem em todos os estados", () => {
    for (const state of [stopped, waiting, connected]) {
      const commands = commandsOf(state);
      expect(commands).toContain(COMMANDS.setPort);
      expect(commands).toContain(COMMANDS.showOutput);
    }
  });

  test("toda opção tem label não vazio e um comando conhecido", () => {
    const known = new Set<string>(Object.values(COMMANDS));
    for (const state of [stopped, waiting, connected]) {
      for (const option of buildMenuOptions(state)) {
        expect(option.label.length).toBeGreaterThan(0);
        expect(known.has(option.command)).toBe(true);
      }
    }
  });
});
