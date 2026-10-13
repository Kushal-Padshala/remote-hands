import { describe, expect, it } from 'vitest';
import { AxHelperClient, type AxSnapshot } from './ax-helper.js';

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
});
