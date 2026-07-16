// Testa o HeartbeatMonitor (módulo puro) com timers fake do vitest — nenhum
// socket é aberto. Cobre o requisito da tarefa: "simular ausência de pong e
// confirmar que o estado vira desconectado" (aqui, no nível do monitor: sem
// recordActivity → onTimeout dispara). vi.useFakeTimers() faz o setInterval E o
// Date.now avançarem sob nosso controle.

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { HeartbeatMonitor } from "../src/sync/HeartbeatMonitor.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HeartbeatMonitor", () => {
  test("sem NENHUMA atividade, dispara onTimeout depois do silêncio passar de timeoutMs", () => {
    let pings = 0;
    let timedOut = 0;
    const hb = new HeartbeatMonitor({
      intervalMs: 1000,
      timeoutMs: 3000,
      sendPing: () => {
        pings++;
      },
      onTimeout: () => {
        timedOut++;
      },
    });

    hb.start();

    // No limiar exato (silêncio == timeoutMs) ainda está vivo: manda ping, não
    // dispara timeout (comparação é estritamente ">").
    vi.advanceTimersByTime(3000);
    expect(timedOut).toBe(0);
    expect(pings).toBe(3); // pings em t=1000, 2000, 3000

    // Passou do limiar: no próximo tick (t=4000) o silêncio (4000) > 3000.
    vi.advanceTimersByTime(1000);
    expect(timedOut).toBe(1);
    // Parou-se sozinho antes de chamar onTimeout — não vira mais pings.
    expect(hb.isRunning()).toBe(false);
    expect(pings).toBe(3);
  });

  test("recordActivity (pong/qualquer mensagem) reseta o relógio e evita o timeout enquanto o plugin responde", () => {
    let timedOut = 0;
    const hb = new HeartbeatMonitor({
      intervalMs: 1000,
      timeoutMs: 3000,
      sendPing: () => {},
      onTimeout: () => {
        timedOut++;
      },
    });

    hb.start();

    // Plugin responde a cada 2s (sempre dentro da janela de 3s) por 20s.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(2000);
      hb.recordActivity();
    }
    expect(timedOut).toBe(0);
    expect(hb.isRunning()).toBe(true);

    // Agora o plugin fica mudo: sem novos recordActivity, deve estourar.
    vi.advanceTimersByTime(4000);
    expect(timedOut).toBe(1);
  });

  test("stop() cancela pings e o timeout", () => {
    let pings = 0;
    let timedOut = 0;
    const hb = new HeartbeatMonitor({
      intervalMs: 1000,
      timeoutMs: 3000,
      sendPing: () => {
        pings++;
      },
      onTimeout: () => {
        timedOut++;
      },
    });

    hb.start();
    vi.advanceTimersByTime(1000);
    expect(pings).toBe(1);

    hb.stop();
    vi.advanceTimersByTime(10000);
    expect(pings).toBe(1); // nenhum ping novo
    expect(timedOut).toBe(0); // nenhum timeout
    expect(hb.isRunning()).toBe(false);
  });

  test("start() é idempotente: um segundo start sem stop não cria um segundo timer", () => {
    let pings = 0;
    const hb = new HeartbeatMonitor({
      intervalMs: 1000,
      timeoutMs: 3000,
      sendPing: () => {
        pings++;
      },
      onTimeout: () => {},
    });

    hb.start();
    hb.start(); // ignorado
    vi.advanceTimersByTime(1000);
    expect(pings).toBe(1); // não 2

    hb.stop();
  });

  test("recordActivity antes de start ou depois de stop é no-op (não lança, não reativa)", () => {
    const hb = new HeartbeatMonitor({
      intervalMs: 1000,
      timeoutMs: 3000,
      sendPing: () => {},
      onTimeout: () => {},
    });

    expect(() => hb.recordActivity()).not.toThrow();
    expect(hb.isRunning()).toBe(false);

    hb.start();
    hb.stop();
    expect(() => hb.recordActivity()).not.toThrow();
    expect(hb.isRunning()).toBe(false);
  });

  test("onDeadLog é chamado no momento da detecção de queda, com o silêncio medido", () => {
    const logs: string[] = [];
    const hb = new HeartbeatMonitor({
      intervalMs: 1000,
      timeoutMs: 3000,
      sendPing: () => {},
      onTimeout: () => {},
      onDeadLog: (message) => logs.push(message),
    });

    hb.start();
    vi.advanceTimersByTime(4000);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("4000ms");
    expect(logs[0]).toContain("3000ms");
  });
});
