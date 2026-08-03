// Analisa o .jsonl gravado por control-server.mjs — agrupa por rateHz e
// calcula, por taxa e por via ("signal" | "poll"):
//   - quantos writes foram enviados pelo escritor
//   - quantos valores DISTINTOS o observador efetivamente viu (evidência de
//     perda/coalescing quando < enviados)
//   - latência em ms: recvMs do evento "observed" - recvMs do evento
//     "write" correspondente (mesmo n). Como os dois recvMs vêm do MESMO
//     relógio (este processo Node), a subtração é válida mesmo os dois
//     Studios rodando em processos separados — mas o número absoluto inclui
//     o hop WS Studio->servidor dos dois lados (ver comentário no .lua);
//     útil para COMPARAR taxas entre si, não como latência pura de Team
//     Create.
//
// Uso: node analyze-log.mjs <arquivo.jsonl>
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("uso: node analyze-log.mjs <arquivo.jsonl>");
  process.exit(1);
}

const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
const events = lines.map((l) => JSON.parse(l));

// writeRecvMsByN[n] = recvMs do evento "write" (ts de escrita, visto pelo servidor)
const writeRecvMsByN = new Map();
const writesByRate = new Map(); // rateHz -> Set(n)
const observedByRateVia = new Map(); // `${rateHz}|${via}` -> Map(n -> latencyMs|null)

for (const ev of events) {
  const m = ev.msg;
  if (m.kind === "write") {
    writeRecvMsByN.set(m.n, ev.recvMs);
    if (!writesByRate.has(m.rateHz)) writesByRate.set(m.rateHz, new Set());
    writesByRate.get(m.rateHz).add(m.n);
  }
}

for (const ev of events) {
  const m = ev.msg;
  if (m.kind === "observed") {
    const key = `${m.rateHz}|${m.via}`;
    if (!observedByRateVia.has(key)) observedByRateVia.set(key, new Map());
    const seen = observedByRateVia.get(key);
    if (!seen.has(m.n)) {
      const writeMs = writeRecvMsByN.get(m.n);
      seen.set(m.n, writeMs != null ? ev.recvMs - writeMs : null);
    }
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function fmtLatency(arr) {
  if (arr.length === 0) return "sem dados";
  return `min=${arr[0]} p50=${percentile(arr, 0.5)} p95=${percentile(arr, 0.95)} max=${arr[arr.length - 1]}`;
}

const rates = [...writesByRate.keys()].sort((a, b) => a - b);
if (rates.length === 0) {
  console.log("Nenhum evento 'write' encontrado no log — o escritor rodou de verdade?");
  process.exit(0);
}

console.log(`Log analisado: ${path} (${events.length} eventos)\n`);
console.log(
  "rateHz | enviados | distintos via sinal (%) | distintos via poll (%) | latência sinal (ms) | latência poll (ms)"
);
console.log("-".repeat(120));

for (const rate of rates) {
  const sent = writesByRate.get(rate).size;
  const sig = observedByRateVia.get(`${rate}|signal`) ?? new Map();
  const poll = observedByRateVia.get(`${rate}|poll`) ?? new Map();
  const sigLat = [...sig.values()].filter((v) => v != null).sort((a, b) => a - b);
  const pollLat = [...poll.values()].filter((v) => v != null).sort((a, b) => a - b);
  const sigPct = ((sig.size / sent) * 100).toFixed(0);
  const pollPct = ((poll.size / sent) * 100).toFixed(0);
  console.log(
    `${String(rate).padStart(6)} | ${String(sent).padStart(8)} | ${String(sig.size).padStart(3)}/${sent} (${sigPct}%) | ${String(poll.size).padStart(3)}/${sent} (${pollPct}%) | ${fmtLatency(sigLat)} | ${fmtLatency(pollLat)}`
  );
}

console.log("\nLeitura: 'distintos' < 'enviados' = perda/coalescing real (valores intermediários nunca observados,");
console.log("nem pelo sinal nem pelo polling de 50ms) — esperado crescer com a taxa se houver coalescing no Team Create.");
