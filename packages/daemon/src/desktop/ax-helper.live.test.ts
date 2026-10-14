import { describe, expect, it } from 'vitest';
import { AxHelperClient, type AxSnapshot } from './ax-helper.js';
import { buildView } from './ax-model.js';

// Live check against the real helper and a real running app. Skipped unless asked:
//   RH_LIVE_AX=1 RH_AX_BIN=/path/to/rh-ax RH_LIVE_APP=Finder npx vitest run packages/daemon/src/desktop/ax-helper.live.test.ts
// Needs Accessibility permission for the terminal; it only reads.
describe.skipIf(!process.env.RH_LIVE_AX)('rh-ax against a real app (read only)', () => {
  const bin = process.env.RH_AX_BIN ?? '';
  const app = process.env.RH_LIVE_APP ?? 'Finder';

  it('answers quickly, with stable ids and a sensible tree', async () => {
    const client = new AxHelperClient({ enabled: true, launch: () => ({ command: bin, args: [] }) });
    try {
      expect(await client.ready()).toBe(true);
      const first = await client.request<AxSnapshot>({ op: 'snapshot', app }, 15_000);
      const second = await client.request<AxSnapshot>({ op: 'snapshot', app }, 15_000);
      expect(first.nodes.length).toBeGreaterThan(5);
      expect(first.truncated).toBe(false);
      expect(second.elapsedMs).toBeLessThan(3000);
      expect(second.nodes.map((n) => n.id)).toEqual(first.nodes.map((n) => n.id));
    } finally {
      client.stop();
    }
  }, 60_000);

  it('renders a compact view (set RH_LIVE_PRINT=1 to print it)', async () => {
    const client = new AxHelperClient({ enabled: true, launch: () => ({ command: bin, args: [] }) });
    try {
      const snap = await client.request<AxSnapshot>({ op: 'snapshot', app }, 15_000);
      const view = buildView(snap);
      if (process.env.RH_LIVE_PRINT) process.stderr.write(`\n${view.text}\n(${snap.nodes.length} raw nodes -> ${view.lines.length} lines, ${snap.elapsedMs} ms)\n`);
      expect(view.lines.length).toBeLessThanOrEqual(155);
      expect(view.text.startsWith('app: ')).toBe(true);
    } finally {
      client.stop();
    }
  }, 60_000);
});

// The picture-reading part of the helper on a fixed image (no screen capture, no Screen Recording permission):
//   RH_LIVE_AX=1 RH_AX_BIN=/path/to/rh-ax RH_AX_FIXTURE=/path/to/screenshot.png npx vitest run packages/daemon/src/desktop/ax-helper.live.test.ts
describe.skipIf(!process.env.RH_LIVE_AX || !process.env.RH_AX_FIXTURE)('rh-ax reads text from a picture', () => {
  it('returns lines with boxes mapped into the window it was told about', async () => {
    const client = new AxHelperClient({ enabled: true, launch: () => ({ command: process.env.RH_AX_BIN ?? '', args: [] }) });
    try {
      expect(await client.ready()).toBe(true);
      const t0 = Date.now();
      const res = await client.request<{ ok: true; lines: Array<{ text: string; x: number; y: number; width: number; height: number }>; ocrMs: number }>(
        { op: 'ocr', image: process.env.RH_AX_FIXTURE, window: { x: 100, y: 50, width: 1200, height: 800 } },
        20_000,
      );
      expect(res.lines.length).toBeGreaterThan(0);
      for (const l of res.lines) {
        expect(l.x).toBeGreaterThanOrEqual(100 - 2);
        expect(l.y).toBeGreaterThanOrEqual(50 - 2);
        expect(l.x + l.width).toBeLessThanOrEqual(1300 + 2);
        expect(l.y + l.height).toBeLessThanOrEqual(850 + 2);
      }
      if (process.env.RH_LIVE_PRINT) process.stderr.write(`\n${res.lines.length} lines, vision ${res.ocrMs} ms, round trip ${Date.now() - t0} ms\n`);
    } finally {
      client.stop();
    }
  }, 60_000);
});
