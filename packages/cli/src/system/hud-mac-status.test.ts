import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  markPermissionPrompted,
  permissionPromptedRecently,
  readMacHudStatus,
  waitForMacHudStatus,
  writeMacHudStatus,
  type MacHudStatus,
} from './hud-mac-status.js';

const status = (over: Partial<MacHudStatus> = {}): MacHudStatus => ({ at: 1000, pid: 1, node: '/n/node', screenRecording: true, ...over });

describe('HUD permission report', () => {
  it('writes and reads the status under the given home, and reads nothing when there is none', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-status-'));
    try {
      expect(readMacHudStatus(home)).toBeNull();
      writeMacHudStatus(status({ screenRecording: false }), home);
      expect(readMacHudStatus(home)).toMatchObject({ screenRecording: false, node: '/n/node' });
      fs.writeFileSync(path.join(home, '.remote-hands', 'hud-mac-status.json'), '{ broken');
      expect(readMacHudStatus(home)).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('waits past a report that is old or still checking, and returns the first final one', async () => {
    const reads = [status({ at: 50 }), status({ at: 2000, checking: true, screenRecording: false }), status({ at: 2100, screenRecording: false })];
    let i = 0;
    const got = await waitForMacHudStatus({ since: 1000, read: () => reads[Math.min(i++, reads.length - 1)] ?? null, sleep: async () => {} });
    expect(got).toMatchObject({ at: 2100, screenRecording: false });
  });

  it('gives up with null when the HUD says nothing in time', async () => {
    expect(await waitForMacHudStatus({ since: 0, timeoutMs: 50, intervalMs: 10, read: () => null, sleep: async () => {} })).toBeNull();
  });

  it('remembers that the permission page was opened, for a day', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-prompt-'));
    try {
      expect(permissionPromptedRecently(home)).toBe(false);
      markPermissionPrompted(home);
      expect(permissionPromptedRecently(home)).toBe(true);
      expect(permissionPromptedRecently(home, Date.now() + 25 * 3_600_000)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
