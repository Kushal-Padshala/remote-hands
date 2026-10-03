#!/usr/bin/env node
// Usage: node scripts/bench-browser.mjs [runs]
// Times the fast browser path (AppleScript + Apple Events JavaScript) against the
// browser the HUD would target now. Read-only except that a snapshot installs small page
// globals (__rhFast, __rhNavHooked) in the active tab: it evaluates `1`, takes snapshots and
// lists tabs; it never launches a browser or changes a setting. Needs `npm run build`.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runsArg = process.argv[2];
const runs = runsArg === undefined ? 5 : Number(runsArg);
if (!Number.isInteger(runs) || runs <= 0) {
  console.error(`Usage: node scripts/bench-browser.mjs [runs]  (runs must be a positive integer, got "${runsArg}")`);
  process.exit(1);
}
const distEntry = fileURLToPath(new URL('../packages/daemon/dist/index.js', import.meta.url));

if (!existsSync(distEntry)) {
  console.error('The daemon is not built. Run `npm run build` first, then retry.');
  process.exit(1);
}

const { AppleScriptTransport, FastBrowserEngine, pickTargetBrowser } = await import(
  pathToFileURL(distEntry).href
);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const transport = new AppleScriptTransport();
let environment;
try {
  environment = await transport.environment();
} catch (err) {
  console.log(`Fast browser path unavailable: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
}

const browser = pickTargetBrowser({
  frontmost: environment.frontmost,
  running: environment.running,
  override: process.env.RH_BROWSER,
});
if (!browser) {
  console.log('Fast browser path unavailable: no supported browser is running (Chrome, Brave, Arc, Edge or Safari).');
  process.exit(0);
}

// Gate: classify the fast path once with the harmless probe, so a missing setting or
// permission prints the remediation instead of a wall of failures.
try {
  await transport.evaluate(browser, null, '1');
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.log(`Fast browser path unavailable for ${browser.name}: ${message}`);
  process.exit(0);
}

// No CDP fallback in the benchmark: every call that cannot use the fast path fails visibly.
const noLegacy = new Proxy(
  {},
  {
    get: () => async () => {
      throw new Error('fast path unavailable (legacy fallback is disabled in the benchmark)');
    },
  },
);
const engine = new FastBrowserEngine({ transport, legacy: noLegacy });

// Like-for-like: engine.reset() runs before every timed call (outside the timing), so the
// snapshot and tabs cases both pay the environment read and nothing is served from a cache.
const cases = [
  ['evaluate(1)', () => transport.evaluate(browser, null, '1')],
  ['snapshot (full)', () => engine.snapshot()],
  ['tabs', () => engine.tabs()],
];

console.log(`Target browser: ${browser.name} (${runs} runs per case)`);
for (const [name, fn] of cases) {
  const samples = [];
  let firstError = null;
  for (let i = 0; i < runs; i += 1) {
    engine.reset();
    const start = process.hrtime.bigint();
    try {
      await fn();
      samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    } catch (err) {
      firstError ??= err instanceof Error ? err.message : String(err);
    }
  }
  const med = samples.length ? Math.round(median(samples)) : 'FAILED';
  console.log(`${name.padEnd(18)} ${String(med).padStart(7)} ms  (${samples.length}/${runs} ok)`);
  if (samples.length === 0 && firstError) console.log(`  first error: ${firstError}`);
}
