import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpotlightHudRunner } from './spotlight-hud.js';
import { clearHudStatus, readHudStatus } from './windows-hud.js';

vi.mock('node:child_process', async (original) => ({ ...(await original<typeof import('node:child_process')>()), spawn: vi.fn(), spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })) }));
vi.mock('./windows-hud.js', async (original) => {
  const real = await original<typeof import('./windows-hud.js')>();
  return { ...real, ensureWindowsHud: () => ({ ok: true, path: 'C:\\hud\\rh-hud.exe' }) };
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stdin: EventEmitter; kill: ReturnType<typeof vi.fn> };
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('the Windows hotkey listener', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.useFakeTimers();
    vi.mocked(spawn).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', platform);
  });

  it('keeps its input open (so the helper ends with this program) and starts the exe built for Windows', () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const listener = new SpotlightHudRunner().startListener(() => {});
    const [file, args, options] = vi.mocked(spawn).mock.calls[0]! as unknown as [string, string[], { stdio: string[] }];
    expect(file).toBe('C:\\hud\\rh-hud.exe');
    expect(args).toEqual(['listen']);
    expect(options.stdio).toEqual(['pipe', 'pipe', 'ignore']);
    listener.stop();
  });

  it('waits longer each time a helper that cannot get its shortcut ends at once, and starts over after a healthy run', async () => {
    const children: Array<ReturnType<typeof fakeChild>> = [];
    vi.mocked(spawn).mockImplementation((() => {
      const c = fakeChild();
      children.push(c);
      return c;
    }) as never);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m: string) => void errors.push(String(m)));
    const listener = new SpotlightHudRunner().startListener(() => {});
    // ends at once, three times: waits 2 s, 4 s, 8 s
    for (const wait of [2000, 4000, 8000]) {
      children.at(-1)!.stdout.emit('data', Buffer.from('{"event":"hotkey-failed"}\n'));
      children.at(-1)!.emit('exit', 3);
      const before = children.length;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(children.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(children.length).toBe(before + 1);
    }
    // the plain-words message is printed once, not at every try
    expect(errors.filter((e) => e.includes('already used by another program'))).toHaveLength(1);
    // a helper that ran for a while was healthy: the next wait is short again
    await vi.advanceTimersByTimeAsync(61_000);
    children.at(-1)!.emit('exit', 0);
    const count = children.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(children.length).toBe(count + 1);
    listener.stop();
  });

  it('keeps "no shortcut was free" on record until a helper says it holds one, and forgets a "ready" when its helper ends', async () => {
    const children: Array<ReturnType<typeof fakeChild>> = [];
    vi.mocked(spawn).mockImplementation((() => {
      const c = fakeChild();
      children.push(c);
      return c;
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const listener = new SpotlightHudRunner().startListener(() => {});
    children[0]!.stdout.emit('data', Buffer.from('{"event":"hotkey-failed"}\n'));
    expect(readHudStatus()?.state).toBe('failed');
    children[0]!.emit('exit', 3);
    expect(readHudStatus()?.state).toBe('failed');
    await vi.advanceTimersByTimeAsync(2000);
    children[1]!.stdout.emit('data', Buffer.from('{"event":"hotkey-ready","keys":"Ctrl+Alt+Space"}\n'));
    expect(readHudStatus()).toMatchObject({ state: 'ready', keys: 'Ctrl+Alt+Space' });
    children[1]!.emit('exit', 1);
    expect(readHudStatus()).toBeUndefined();
    listener.stop();
  });
});

describe('the Mac hotkey listener', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.useFakeTimers();
    vi.mocked(spawn).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', platform);
    clearHudStatus();
  });

  it('records that the helper holds Shift+Cmd+Space, and forgets it when the helper ends', () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const listener = new SpotlightHudRunner().startListener(() => {});
    child.stdout.emit('data', Buffer.from('{"event":"hotkey-ready","keys":"Shift+Cmd+Space"}\n'));
    expect(readHudStatus()).toMatchObject({ state: 'ready', keys: 'Shift+Cmd+Space' });
    child.emit('exit', 0);
    expect(readHudStatus()).toBeUndefined();
    listener.stop();
  });

  it('says in Mac words, once, when another app holds the shortcut, and still delivers key presses', () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m: string) => void errors.push(String(m)));
    const seen: string[] = [];
    const listener = new SpotlightHudRunner().startListener((e) => seen.push((e as { app: string }).app));
    child.stdout.emit('data', Buffer.from('{"event":"hotkey-failed"}\n'));
    child.stdout.emit('data', Buffer.from('{"event":"hotkey-failed"}\n'));
    expect(errors.filter((e) => e.includes('Raycast'))).toHaveLength(1);
    expect(errors.join('\n')).not.toContain('Ctrl');
    child.stdout.emit('data', Buffer.from('{"event":"hotkey","app":"Notes","windowTitle":"x"}\n'));
    expect(seen).toEqual(['Notes']);
    listener.stop();
  });
});
