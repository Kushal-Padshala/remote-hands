import { afterEach, describe, expect, it, vi } from 'vitest';
import { doctorCommand } from './doctor.js';
import * as macStatus from '../system/hud-mac-status.js';
import * as daemon from '@remote-hands/daemon';

describe('rh doctor: Desktop HUD on a Mac', () => {
  const original = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: original });
    vi.restoreAllMocks();
  });

  async function lines(service: Record<string, unknown>): Promise<string> {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const out: string[] = [];
    await doctorCommand([], {
      stdout: (l) => out.push(l),
      runner: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
      fs: { readFile: async () => '{}', writeFile: async () => {}, exists: async () => false },
      hudServiceManager: service,
    } as never);
    return out.filter((l) => l.includes('Desktop HUD')).join('\n');
  }

  it('says it is not installed', async () => {
    expect(await lines({ isInstalled: () => false, isRunning: () => false })).toContain('Desktop HUD: not installed');
  });

  it('says it is installed but not running, with where to look', async () => {
    const text = await lines({ isInstalled: () => true, isRunning: () => false });
    expect(text).toContain('installed but not running');
    expect(text).toContain('hud.error.log');
  });

  it('confirms a running HUD that holds its shortcut and has Screen Recording', async () => {
    vi.spyOn(daemon, 'readHudStatus').mockReturnValue({ state: 'ready', keys: 'Shift+Cmd+Space', at: 1 });
    vi.spyOn(macStatus, 'readMacHudStatus').mockReturnValue({ at: 1, pid: 1, node: '/n/node', screenRecording: true });
    const text = await lines({ isInstalled: () => true, isRunning: () => true, installedCopyIsStale: () => false });
    expect(text).toContain('[✓] Desktop HUD: running; press');
    expect(text).toContain('[✓] Desktop HUD Screen Recording: granted');
    expect(text).not.toContain('older copy');
  });

  it('names the exact node when the background HUD lacks Screen Recording, and flags an older copy', async () => {
    vi.spyOn(daemon, 'readHudStatus').mockReturnValue({ state: 'failed', at: 1 });
    vi.spyOn(macStatus, 'readMacHudStatus').mockReturnValue({ at: 1, pid: 1, node: '/Users/x/.nvm/versions/node/v22/bin/node', screenRecording: false });
    const text = await lines({ isInstalled: () => true, isRunning: () => true, installedCopyIsStale: () => true });
    expect(text).toContain('/Users/x/.nvm/versions/node/v22/bin/node');
    expect(text).toContain('used by another app');
    expect(text).toContain('older copy');
  });
});
