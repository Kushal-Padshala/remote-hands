import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { SpotlightHudRunner } from './spotlight-hud.js';

// Parse prompt responses without compiling Swift or opening a real native HUD.
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: 'native helper unavailable in unit tests' })),
  spawn: vi.fn(() => ({
    on: vi.fn(), stdout: { on: vi.fn() }, stdin: { writable: false }, killed: false,
    kill: vi.fn(), unref: vi.fn(),
  })),
}));

describe('SpotlightHudRunner', () => {
  let mockExec: any;
  let runner: SpotlightHudRunner;

  beforeEach(() => {
    mockExec = vi.fn();
    runner = new SpotlightHudRunner(mockExec);
  });

  it('parses successful prompt response from swift hud', async () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify({ query: 'how to upload a new file', app: 'Photoshop' }),
      stderr: '',
      status: 0,
    });

    const result = await runner.openPrompt('Photoshop');
    expect(result).toEqual({ query: 'how to upload a new file', app: 'Photoshop' });
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringMatching(/swift|rh-spotlight/),
      expect.arrayContaining(['prompt', '--app=Photoshop'])
    );
  });

  it('returns null when user cancels prompt or exits with non-zero status', async () => {
    mockExec.mockReturnValue({
      stdout: '',
      stderr: 'cancelled',
      status: 1,
    });

    const result = await runner.openPrompt();
    expect(result).toBeNull();
  });

  it('handles invalid json output gracefully', async () => {
    mockExec.mockReturnValue({
      stdout: 'not a json',
      stderr: '',
      status: 0,
    });

    const result = await runner.openPrompt();
    expect(result).toBeNull();
  });

  it('exposes openInteractivePrompt method returning a close handle', () => {
    const handle = runner.openInteractivePrompt('Finder', () => {});
    expect(handle).toBeDefined();
    expect(typeof handle.close).toBe('function');
    handle.close();
  });

  it('triggers onCancel when handle.close is invoked', () => {
    const onCancel = vi.fn();
    const handle = runner.openInteractivePrompt('Finder', () => {}, onCancel);
    handle.close();
    expect(onCancel).toHaveBeenCalled();
  });

  it('accepts onStop callback in openInteractivePrompt', () => {
    const onCancel = vi.fn();
    const onStop = vi.fn();
    const handle = runner.openInteractivePrompt('Finder', () => {}, onCancel, onStop);
    expect(handle).toBeDefined();
    handle.close();
    expect(onCancel).toHaveBeenCalled();
  });

  it('gives the prompt window the models to offer and passes the pick back with each prompt', () => {
    let onData: ((chunk: Buffer) => void) | undefined;
    vi.mocked(spawn).mockImplementationOnce(((..._a: unknown[]) => ({
      on: vi.fn(), stdout: { on: (_e: string, cb: (chunk: Buffer) => void) => { onData = cb; } }, stdin: { writable: false }, killed: false,
      kill: vi.fn(), unref: vi.fn(),
    })) as never);
    const submitted: any[] = [];
    const picked: string[] = [];
    const models = [{ key: 'a', label: 'Model A' }, { key: 'b', label: 'Model B' }];
    runner.openInteractivePrompt('Notes', (r) => { submitted.push(r); }, undefined, undefined, undefined, { models, model: 'b', onModel: (k) => picked.push(k) });
    const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
    expect(args).toContain(`--models=${JSON.stringify(models)}`);
    expect(args).toContain('--model=b');
    onData!(Buffer.from('{"event":"model","model":"a"}\n{"event":"submit","query":"do it","app":"Notes","model":"a"}\n'));
    expect(picked).toEqual(['a']);
    expect(submitted).toEqual([{ query: 'do it', app: 'Notes', windowTitle: undefined, attachments: undefined, model: 'a' }]);
  });

  it('answers /history and /resume lines from the prompt window', async () => {
    let onData: ((chunk: Buffer) => void) | undefined;
    const written: string[] = [];
    vi.mocked(spawn).mockImplementationOnce(((..._a: unknown[]) => ({
      on: vi.fn(), stdout: { on: (_e: string, cb: (chunk: Buffer) => void) => { onData = cb; } },
      stdin: { writable: true, write: (s: string) => { written.push(s); return true; } }, killed: false, kill: vi.fn(), unref: vi.fn(),
    })) as never);
    const history = {
      list: vi.fn().mockResolvedValue([{ id: 'c1', title: 'hello', when: '1h ago', count: 2 }]),
      resume: vi.fn().mockImplementation(async (id: string) => (id === 'c1' ? { id: 'c1', title: 'hello', turns: [{ goal: 'g', answer: 'a' }] } : null)),
    };
    runner.openInteractivePrompt('Notes', () => {}, undefined, undefined, undefined, undefined, history);
    onData!(Buffer.from('{"event":"history"}\n{"event":"resume","id":"c1"}\n{"event":"resume","id":"gone"}\n'));
    await new Promise((r) => setTimeout(r, 10));
    const lines = written.map((w) => JSON.parse(w));
    expect(lines).toContainEqual({ event: 'history-list', items: [{ id: 'c1', title: 'hello', when: '1h ago', count: 2 }] });
    expect(lines).toContainEqual({ event: 'resumed', id: 'c1', title: 'hello', turns: [{ goal: 'g', answer: 'a' }] });
    // an id that is gone: the window gets an empty list instead of waiting forever
    expect(lines.filter((l) => l.event === 'history-list').at(-1)).toEqual({ event: 'history-list', items: [] });
  });

  it('holds a prompt that arrives while a chat is being resumed until the switch is done', async () => {
    let onData: ((chunk: Buffer) => void) | undefined;
    vi.mocked(spawn).mockImplementationOnce(((..._a: unknown[]) => ({
      on: vi.fn(), stdout: { on: (_e: string, cb: (chunk: Buffer) => void) => { onData = cb; } },
      stdin: { writable: true, write: () => true }, killed: false, kill: vi.fn(), unref: vi.fn(),
    })) as never);
    const order: string[] = [];
    let finish!: () => void;
    const history = {
      list: vi.fn().mockResolvedValue([]),
      resume: vi.fn().mockImplementation(() => new Promise((r) => { finish = () => { order.push('resumed'); r({ id: 'c1', title: 't', turns: [] }); }; })),
    };
    runner.openInteractivePrompt('Notes', () => { order.push('submit'); }, undefined, undefined, undefined, undefined, history);
    onData!(Buffer.from('{"event":"resume","id":"c1"}\n{"event":"submit","query":"next","app":"Notes"}\n'));
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
    finish();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['resumed', 'submit']);
  });

  it('answers /history with an empty list when no history is offered', async () => {
    let onData: ((chunk: Buffer) => void) | undefined;
    const written: string[] = [];
    vi.mocked(spawn).mockImplementationOnce(((..._a: unknown[]) => ({
      on: vi.fn(), stdout: { on: (_e: string, cb: (chunk: Buffer) => void) => { onData = cb; } },
      stdin: { writable: true, write: (s: string) => { written.push(s); return true; } }, killed: false, kill: vi.fn(), unref: vi.fn(),
    })) as never);
    runner.openInteractivePrompt('Notes', () => {});
    onData!(Buffer.from('{"event":"history"}\n'));
    await new Promise((r) => setTimeout(r, 5));
    expect(written.map((w) => JSON.parse(w))).toContainEqual({ event: 'history-list', items: [] });
  });

  it('passes an Allow or Deny from the window to the coordinator and tells the window what stands', async () => {
    let onData: ((chunk: Buffer) => void) | undefined;
    const written: string[] = [];
    vi.mocked(spawn).mockImplementationOnce(((..._a: unknown[]) => ({
      on: vi.fn(), stdout: { on: (_e: string, cb: (chunk: Buffer) => void) => { onData = cb; } },
      stdin: { writable: true, write: (s: string) => { written.push(s); return true; } }, killed: false, kill: vi.fn(), unref: vi.fn(),
    })) as never);
    const approvals = { decide: vi.fn().mockImplementation(async (_id: string, ok: boolean) => (ok ? 'approved' : 'rejected')) };
    runner.openInteractivePrompt('Notes', () => {}, undefined, undefined, undefined, undefined, undefined, approvals);
    onData!(Buffer.from('{"event":"approval","id":"a1","decision":"approved"}\n{"event":"approval","id":"a2","decision":"rejected"}\n{"event":"approval","id":"a3"}\n'));
    await new Promise((r) => setTimeout(r, 10));
    expect(approvals.decide.mock.calls).toEqual([['a1', true], ['a2', false], ['a3', false]]);
    const lines = written.map((w) => JSON.parse(w));
    expect(lines).toContainEqual({ event: 'approval-closed', id: 'a1', outcome: 'approved' });
    expect(lines).toContainEqual({ event: 'approval-closed', id: 'a2', outcome: 'rejected' });
  });

  it.runIf(process.platform === 'darwin')('lets the coordinator put the Allow / Deny card up and take it down', () => {
    const written: string[] = [];
    let onData: ((chunk: Buffer) => void) | undefined;
    vi.mocked(spawn).mockImplementationOnce(((..._a: unknown[]) => ({
      on: vi.fn(), stdout: { on: (_e: string, cb: (chunk: Buffer) => void) => { onData = cb; } },
      stdin: { writable: true, write: (s: string) => { written.push(s); return true; } }, killed: false, kill: vi.fn(), unref: vi.fn(),
    })) as never);
    let sender: any;
    runner.openInteractivePrompt('Notes', (_r, send) => { sender = send; }, undefined, undefined, undefined, undefined, undefined, { decide: vi.fn() });
    onData!(Buffer.from('{"event":"submit","query":"x","app":"Notes"}\n'));
    sender.approval({ id: 'a1', summary: 'Press "Submit"', risk: 'high' });
    sender.approvalClosed('a1', 'expired');
    sender('WORKING', 'hi');
    expect(written.map((w) => JSON.parse(w))).toEqual([
      { event: 'approval', id: 'a1', summary: 'Press "Submit"', risk: 'high' },
      { event: 'approval-closed', id: 'a1', outcome: 'expired' },
      { status: 'WORKING', text: 'hi' },
    ]);
  });

  it('offers no approval card when the window was not given a way to answer', () => {
    const feeds: any[] = [];
    vi.mocked(spawn).mockImplementationOnce(((..._a: unknown[]) => ({
      on: vi.fn(), stdout: { on: (_e: string, cb: (chunk: Buffer) => void) => feeds.push(cb) },
      stdin: { writable: true, write: () => true }, killed: false, kill: vi.fn(), unref: vi.fn(),
    })) as never);
    let sender: any;
    runner.openInteractivePrompt('Notes', (_r, send) => { sender = send; });
    feeds[0](Buffer.from('{"event":"submit","query":"x","app":"Notes"}\n'));
    expect(sender.approval).toBeUndefined();
  });

  it('offers no model arguments when there is no choice to make', () => {
    runner.openInteractivePrompt('Notes', () => {});
    const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
    expect(args.some((a) => a.startsWith('--model'))).toBe(false);
  });

  it('parses attachments in prompt response from swift hud', async () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify({
        query: 'check the ad campaign',
        app: 'Arc',
        attachments: [
          {
            type: 'browser_tab',
            id: 'tab-1',
            browser: 'Arc',
            title: 'Meta Ads Manager',
            url: 'https://adsmanager.facebook.com',
          },
        ],
      }),
      stderr: '',
      status: 0,
    });

    const result = await runner.openPrompt('Arc');
    expect(result).toEqual({
      query: 'check the ad campaign',
      app: 'Arc',
      attachments: [
        {
          type: 'browser_tab',
          id: 'tab-1',
          browser: 'Arc',
          title: 'Meta Ads Manager',
          url: 'https://adsmanager.facebook.com',
        },
      ],
    });
  });
});


describe('embedded hotkey helper source', () => {
  it('matches spotlight-hud.swift (run `npm run build -w @remote-hands/daemon` after editing the Swift file)', async () => {
    const fsm = await import('node:fs');
    const pathm = await import('node:path');
    const { SPOTLIGHT_SWIFT_SOURCE } = await import('./spotlight-source.generated.js');
    const file = pathm.join(__dirname, 'spotlight-hud.swift');
    expect(SPOTLIGHT_SWIFT_SOURCE).toBe(fsm.readFileSync(file, 'utf-8'));
  });

  it('materializeSwiftSource writes it when missing, repairs a stale copy, and leaves a fresh copy untouched', async () => {
    const fsm = await import('node:fs');
    const osm = await import('node:os');
    const pathm = await import('node:path');
    const { materializeSwiftSource } = await import('./spotlight-hud.js');
    const home = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'rh-swift-'));
    try {
      const target = materializeSwiftSource(home, 'v1');
      expect(target).toBe(pathm.join(home, '.remote-hands', 'spotlight-hud.swift'));
      expect(fsm.readFileSync(target, 'utf-8')).toBe('v1');
      const old = new Date(Date.now() - 60_000);
      fsm.utimesSync(target, old, old);
      materializeSwiftSource(home, 'v1');
      expect(fsm.statSync(target).mtimeMs).toBeLessThan(Date.now() - 30_000);
      materializeSwiftSource(home, 'v2');
      expect(fsm.readFileSync(target, 'utf-8')).toBe('v2');
    } finally {
      fsm.rmSync(home, { recursive: true, force: true });
    }
  });
});
