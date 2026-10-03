#!/usr/bin/env node
// Usage: node scripts/bench-actions.mjs [runs]
import { spawnSync } from 'node:child_process';

const runs = Number(process.argv[2] ?? 5);

function timeMs(cmd, args) {
  const start = process.hrtime.bigint();
  const res = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 120_000 });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms, ok: res.status === 0 };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const cases = [
  ['rh desktop window list', 'rh', ['desktop', 'window', 'list']],
  ['rh desktop snapshot --no-ocr', 'rh', ['desktop', 'snapshot', '--no-ocr']],
  ['rh browser tabs', 'rh', ['browser', 'tabs']],
  [
    'agy cold turn (flash, low)',
    'agy',
    ['-p', 'reply with the single word ok', '--model', 'gemini-3.8-flash', '--effort', 'low', '--output-format', 'stream-json'],
  ],
];

for (const [name, cmd, args] of cases) {
  const samples = [];
  const n = name.startsWith('agy') ? Math.min(runs, 3) : runs;
  for (let i = 0; i < n; i += 1) {
    const { ms, ok } = timeMs(cmd, args);
    if (ok) samples.push(ms);
  }
  const med = samples.length ? Math.round(median(samples)) : 'FAILED';
  console.log(`${name.padEnd(34)} ${String(med).padStart(7)} ms  (${samples.length}/${n} ok)`);
}
