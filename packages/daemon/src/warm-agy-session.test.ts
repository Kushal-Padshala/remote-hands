import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WarmAgySession, buildWarmAgyArgs } from './warm-agy-session.js';
import type { EventInput } from './task-store.js';

class FakeProc extends EventEmitter {
  stdin: PassThrough | null = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 123;
  killed = false;
  written: string[] = [];
  constructor() {
    super();
    this.stdin!.on('data', (c) => this.written.push(String(c)));
  }
  kill() {
    this.killed = true;
    this.emit('close', null);
    return true;
  }
  reply(response: string, conversationId = 'conv-1', status = 'SUCCESS') {
    this.stdout.write(
      JSON.stringify({ event: 'result', result: { conversation_id: conversationId, status, response } }) + '\n',
    );
  }
}

function parseLine(line: string): EventInput | null {
  const rec = JSON.parse(line);
  if (rec.event === 'result') {
    const payload: any = { summary: rec.result.response, conversation_id: rec.result.conversation_id };
    if (rec.result.status === 'ERROR') payload.is_error = true;
    return { kind: 'result', payload };
  }
  if (rec.event === 'fatal') {
    return { kind: 'error', payload: { message: rec.message, fatal: true } };
  }
  return { kind: 'agent_text', payload: { text: line } };
}

const config = { model: 'gemini-3.8-flash', effort: 'low' };

function makeSession() {
  const procs: FakeProc[] = [];
  const spawnFn = vi.fn((_cmd: string, _args: string[], _opts?: any) => {
    const p = new FakeProc();
    procs.push(p);
    return p as any;
  });
  const killFn = vi.fn((proc: any, _signal?: string) => {
    proc.kill();
  });
  const session = new WarmAgySession({ command: 'agy', parseLine, spawnFn: spawnFn as any, killFn: killFn as any });
  return { session, procs, spawnFn, killFn };
}

describe('buildWarmAgyArgs', () => {
  it('builds stream-json args with model, effort, workspace and conversation', () => {
    expect(
      buildWarmAgyArgs({ model: 'gemini-3.8-flash', effort: 'low', workspace: '/w', mode: 'plan', conversationId: 'c1' }),
    ).toEqual([
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '0',
      '--add-dir', '/w', '--conversation', 'c1', '--mode', 'plan',
      '--model', 'gemini-3.8-flash', '--effort', 'low', '-p=',
    ]);
  });

  it('omits effort for claude models', () => {
    expect(buildWarmAgyArgs({ model: 'claude-sonnet-4-6', effort: 'low' })).not.toContain('--effort');
  });
});

describe('WarmAgySession', () => {
  it('spawns once, sends a user event per turn and resolves on the result event', async () => {
    const { session, procs, spawnFn } = makeSession();
    const first = session.runTurn('hello', config);
    await Promise.resolve();
    procs[0]!.reply('one');
    const r1 = await first;
    expect(r1).toMatchObject({ summary: 'one', conversationId: 'conv-1', failed: false, aborted: false });
    const second = session.runTurn('again', config);
    await Promise.resolve();
    procs[0]!.reply('two');
    expect((await second).summary).toBe('two');
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(procs[0]!.written.join('')).toBe(
      '{"event":"user","message":{"content":"hello"}}\n{"event":"user","message":{"content":"again"}}\n',
    );
    expect(session.hasHistory()).toBe(true);
  });

  it('forwards events to onEvent in order', async () => {
    const { session, procs } = makeSession();
    const seen: string[] = [];
    const turn = session.runTurn('x', config, (e) => { seen.push(e.kind); });
    await Promise.resolve();
    procs[0]!.stdout.write('{"event":"step_update"}\n');
    procs[0]!.reply('done');
    await turn;
    expect(seen).toEqual(['agent_text', 'result']);
  });

  it('reset kills the process and starts the next turn without --conversation', async () => {
    const { session, procs, spawnFn } = makeSession();
    const t1 = session.runTurn('a', config);
    await Promise.resolve();
    procs[0]!.reply('A', 'conv-5');
    await t1;
    session.reset();
    expect(procs[0]!.killed).toBe(true);
    expect(session.hasHistory()).toBe(false);
    const t2 = session.runTurn('b', config);
    await Promise.resolve();
    expect(spawnFn.mock.calls[1]![1]).not.toContain('--conversation');
    procs[1]!.reply('B', 'conv-6');
    await t2;
  });

  it('prewarm spawns without sending anything', () => {
    const { session, procs, spawnFn } = makeSession();
    session.prewarm(config);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(procs[0]!.written).toEqual([]);
  });

  it('restarts with --conversation when the process died between turns', async () => {
    const { session, procs, spawnFn } = makeSession();
    const t1 = session.runTurn('a', config);
    await Promise.resolve();
    procs[0]!.reply('A', 'conv-9');
    await t1;
    procs[0]!.emit('close', 1);
    const t2 = session.runTurn('b', config);
    await Promise.resolve();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(spawnFn.mock.calls[1]![1]).toEqual(expect.arrayContaining(['--conversation', 'conv-9']));
    procs[1]!.reply('B', 'conv-9');
    expect((await t2).summary).toBe('B');
  });

  it('restarts when model or effort changes', async () => {
    const { session, procs, spawnFn } = makeSession();
    const t1 = session.runTurn('a', config);
    await Promise.resolve();
    procs[0]!.reply('A');
    await t1;
    const t2 = session.runTurn('b', { model: 'gemini-3.1-pro-high', effort: 'high' });
    await Promise.resolve();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(procs[0]!.killed).toBe(true);
    procs[1]!.reply('B');
    await t2;
  });

  it('abort kills the process, resolves aborted, and the next turn respawns', async () => {
    const { session, procs, spawnFn } = makeSession();
    const ctrl = new AbortController();
    const t1 = session.runTurn('a', config, undefined, ctrl.signal);
    await Promise.resolve();
    ctrl.abort();
    const r1 = await t1;
    expect(r1.aborted).toBe(true);
    expect(procs[0]!.killed).toBe(true);
    const t2 = session.runTurn('b', config);
    await Promise.resolve();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    procs[1]!.reply('B');
    expect((await t2).summary).toBe('B');
  });

  it('resolves failed when the process dies mid-turn', async () => {
    const { session, procs } = makeSession();
    const t = session.runTurn('a', config);
    await Promise.resolve();
    procs[0]!.emit('close', 1);
    expect(await t).toMatchObject({ failed: true, aborted: false });
  });

  it('serializes overlapping turns', async () => {
    const { session, procs } = makeSession();
    const t1 = session.runTurn('a', config);
    const t2 = session.runTurn('b', config);
    await Promise.resolve();
    expect(procs[0]!.written.join('')).toBe('{"event":"user","message":{"content":"a"}}\n');
    procs[0]!.reply('A');
    await t1;
    await Promise.resolve();
    await Promise.resolve();
    expect(procs[0]!.written.join('')).toContain('"content":"b"');
    procs[0]!.reply('B');
    expect((await t2).summary).toBe('B');
  });
});

describe('WarmAgySession lifecycle hardening', () => {
  it('resolves the active turn as failed on a spawn error event without throwing', async () => {
    const { session, procs } = makeSession();
    const t = session.runTurn('a', config);
    await Promise.resolve();
    procs[0]!.emit('error', Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }));
    const r = await t;
    expect(r).toMatchObject({ failed: true, aborted: false });
    expect(r.summary).toContain('ENOENT');
  });

  it('does not crash on stdin EPIPE errors', async () => {
    const { session, procs } = makeSession();
    const t = session.runTurn('a', config);
    await Promise.resolve();
    expect(() => procs[0]!.stdin!.emit('error', new Error('write EPIPE'))).not.toThrow();
    procs[0]!.reply('A');
    await t;
  });

  it('consumes stderr so the child never blocks on a full pipe', () => {
    const { session, procs } = makeSession();
    session.prewarm(config);
    expect(procs[0]!.stderr.listenerCount('data')).toBeGreaterThan(0);
  });

  it('removes the abort listener when a turn ends normally', async () => {
    const { session, procs } = makeSession();
    const ctrl = new AbortController();
    const remove = vi.spyOn(ctrl.signal, 'removeEventListener');
    const t = session.runTurn('a', config, undefined, ctrl.signal);
    await Promise.resolve();
    procs[0]!.reply('A');
    await t;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    ctrl.abort();
    expect(procs[0]!.killed).toBe(false);
  });

  it('resolves a turn only once even if result and close both arrive', async () => {
    const { session, procs } = makeSession();
    const t = session.runTurn('a', config);
    await Promise.resolve();
    procs[0]!.reply('A');
    procs[0]!.emit('close', 0);
    const r = await t;
    expect(r).toMatchObject({ summary: 'A', failed: false });
  });

  it('fails the turn when stdin is unavailable', async () => {
    const { session, spawnFn } = makeSession();
    spawnFn.mockImplementationOnce(() => {
      const p = new FakeProc();
      p.stdin = null;
      return p as any;
    });
    const r = await session.runTurn('a', config);
    expect(r).toMatchObject({ failed: true, aborted: false });
  });

  it('spawns detached on non-win32 and kills through the injected kill function', async () => {
    const { session, procs, spawnFn, killFn } = makeSession();
    session.prewarm(config);
    const opts = spawnFn.mock.calls[0]![2];
    expect(Boolean(opts.detached)).toBe(process.platform !== 'win32');
    session.stop();
    expect(killFn).toHaveBeenCalledWith(procs[0], 'SIGTERM');
  });

  it('survives a throwing kill function', () => {
    const { session, killFn } = makeSession();
    killFn.mockImplementation(() => {
      throw new Error('ESRCH');
    });
    session.prewarm(config);
    expect(() => session.stop()).not.toThrow();
  });

  it('stop and reset resolve an in-flight turn as failed instead of hanging', async () => {
    for (const method of ['stop', 'reset'] as const) {
      const { session } = makeSession();
      const t = session.runTurn('a', config);
      await Promise.resolve();
      session[method]();
      expect(await t).toMatchObject({ failed: true, aborted: false });
    }
  });

  it('reset keeps an idle prewarmed process that has no history', async () => {
    const { session, procs, spawnFn, killFn } = makeSession();
    session.prewarm(config);
    session.reset();
    expect(killFn).not.toHaveBeenCalled();
    expect(procs[0]!.killed).toBe(false);
    const t = session.runTurn('a', config);
    await Promise.resolve();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    procs[0]!.reply('A');
    await t;
  });

  it('reset after a completed turn kills the process and forgets history', async () => {
    const { session, procs, killFn } = makeSession();
    const t = session.runTurn('a', config);
    await Promise.resolve();
    procs[0]!.reply('A');
    await t;
    session.reset();
    expect(killFn).toHaveBeenCalledTimes(1);
    expect(session.hasHistory()).toBe(false);
  });

  it('resolves failed when the result event is an error, keeping the summary', async () => {
    const { session, procs } = makeSession();
    const t = session.runTurn('a', config);
    await Promise.resolve();
    procs[0]!.reply('quota exceeded', 'conv-1', 'ERROR');
    expect(await t).toMatchObject({ failed: true, aborted: false, summary: 'quota exceeded' });
  });

  it('a fatal error event fails the turn, kills the process, and the next turn resumes the conversation', async () => {
    const { session, procs, spawnFn, killFn } = makeSession();
    const t1 = session.runTurn('a', config);
    await Promise.resolve();
    procs[0]!.reply('A', 'conv-7');
    await t1;
    const t2 = session.runTurn('b', config);
    await Promise.resolve();
    procs[0]!.stdout.write('{"event":"fatal","message":"agy crashed hard"}\n');
    const r2 = await t2;
    expect(r2).toMatchObject({ failed: true, aborted: false, summary: 'agy crashed hard' });
    expect(killFn).toHaveBeenCalledWith(procs[0], 'SIGTERM');
    const t3 = session.runTurn('c', config);
    await Promise.resolve();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(spawnFn.mock.calls[1]![1]).toEqual(expect.arrayContaining(['--conversation', 'conv-7']));
    procs[1]!.reply('C', 'conv-7');
    expect((await t3).summary).toBe('C');
  });

  it('a served turn without a conversation_id still counts as history: reset kills and the next turn spawns fresh', async () => {
    const { session, procs, spawnFn, killFn } = makeSession();
    const t1 = session.runTurn('a', config);
    await Promise.resolve();
    procs[0]!.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'A' } }) + '\n');
    expect((await t1).conversationId).toBeNull();
    expect(session.hasHistory()).toBe(true);
    session.reset();
    expect(killFn).toHaveBeenCalledWith(procs[0], 'SIGTERM');
    expect(session.hasHistory()).toBe(false);
    const t2 = session.runTurn('b', config);
    await Promise.resolve();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(spawnFn.mock.calls[1]![1]).not.toContain('--conversation');
    procs[1]!.reply('B', 'conv-2');
    expect((await t2).summary).toBe('B');
  });

  it('a fatal error event during prewarm kills the process and the next turn respawns', async () => {
    const { session, procs, spawnFn, killFn } = makeSession();
    session.prewarm(config);
    procs[0]!.stdout.write('{"event":"fatal","message":"auth expired"}\n');
    await new Promise((r) => setImmediate(r));
    expect(killFn).toHaveBeenCalledWith(procs[0], 'SIGTERM');
    const t = session.runTurn('a', config);
    await Promise.resolve();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(procs[1]!.written.join('')).toContain('"content":"a"');
    procs[1]!.reply('A');
    expect((await t).summary).toBe('A');
  });

  it('reset kills a process that was respawned with --conversation even before it serves a turn', async () => {
    const { session, procs, spawnFn } = makeSession();
    const t1 = session.runTurn('a', config);
    await Promise.resolve();
    procs[0]!.reply('A', 'conv-3');
    await t1;
    procs[0]!.emit('close', 1);
    session.prewarm(config);
    expect(spawnFn.mock.calls[1]![1]).toEqual(expect.arrayContaining(['--conversation', 'conv-3']));
    session.reset();
    expect(procs[1]!.killed).toBe(true);
    expect(session.hasHistory()).toBe(false);
  });
});

describe('WarmAgySession workspace', () => {
  it('replaces a workspace-less prewarmed process when a workspace task arrives', async () => {
    const { session, procs, spawnFn } = makeSession();
    session.prewarm(config);
    const t = session.runTurn('a', { ...config, workspace: '/ws/one' });
    await Promise.resolve();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(procs[0]!.killed).toBe(true);
    expect(spawnFn.mock.calls[1]![1]).toEqual(expect.arrayContaining(['--add-dir', '/ws/one']));
    expect(spawnFn.mock.calls[1]![2].cwd).toBe('/ws/one');
    expect(procs[1]!.written.join('')).toContain('"content":"a"');
    procs[1]!.reply('A');
    expect((await t).summary).toBe('A');
  });

  it('a workspace switch respawns in the new workspace and resumes the conversation', async () => {
    const { session, procs, spawnFn } = makeSession();
    const t1 = session.runTurn('a', { ...config, workspace: '/ws/one' });
    await Promise.resolve();
    procs[0]!.reply('A', 'conv-c');
    await t1;
    const t2 = session.runTurn('b', { ...config, workspace: '/ws/two' });
    await Promise.resolve();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(procs[0]!.killed).toBe(true);
    const args = spawnFn.mock.calls[1]![1];
    expect(args).toEqual(expect.arrayContaining(['--conversation', 'conv-c']));
    expect(args).toEqual(expect.arrayContaining(['--add-dir', '/ws/two']));
    expect(spawnFn.mock.calls[1]![2].cwd).toBe('/ws/two');
    procs[1]!.reply('B', 'conv-c');
    await t2;
    // A later workspace-less task reuses whatever process is live.
    const t3 = session.runTurn('c', config);
    await Promise.resolve();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(procs[1]!.written.join('')).toContain('"content":"c"');
    procs[1]!.reply('C', 'conv-c');
    await t3;
  });

  it('reuses the process for the same workspace', async () => {
    const { session, procs, spawnFn } = makeSession();
    const t1 = session.runTurn('a', { ...config, workspace: '/ws/one' });
    await Promise.resolve();
    procs[0]!.reply('A');
    await t1;
    const t2 = session.runTurn('b', { ...config, workspace: '/ws/one' });
    await Promise.resolve();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    procs[0]!.reply('B');
    await t2;
  });
});

describe('WarmAgySession requested conversation', () => {
  it('respawns with --conversation when the requested id differs from the active one, and reuses it when equal', async () => {
    const { session, procs, spawnFn } = makeSession();
    const t1 = session.runTurn('a', config);
    await Promise.resolve();
    procs[0]!.reply('A', 'conv-c');
    await t1;
    const t2 = session.runTurn('b', { ...config, conversationId: 'conv-x' });
    await Promise.resolve();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(procs[0]!.killed).toBe(true);
    expect(spawnFn.mock.calls[1]![1]).toEqual(expect.arrayContaining(['--conversation', 'conv-x']));
    expect(procs[1]!.written.join('')).toContain('"content":"b"');
    procs[1]!.reply('B', 'conv-x');
    await t2;
    const t3 = session.runTurn('c', { ...config, conversationId: 'conv-x' });
    await Promise.resolve();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    procs[1]!.reply('C', 'conv-x');
    await t3;
  });

  it('replaces a fresh prewarmed process when a conversation id is requested', async () => {
    const { session, procs, spawnFn } = makeSession();
    session.prewarm(config);
    expect(session.hasHistory()).toBe(false);
    const t = session.runTurn('a', { ...config, conversationId: 'conv-x' });
    await Promise.resolve();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(procs[0]!.killed).toBe(true);
    expect(spawnFn.mock.calls[1]![1]).toEqual(expect.arrayContaining(['--conversation', 'conv-x']));
    procs[1]!.reply('A', 'conv-x');
    expect((await t).summary).toBe('A');
  });

  it('spawns with the requested id when no process is live', async () => {
    const { session, procs, spawnFn } = makeSession();
    const t = session.runTurn('a', { ...config, conversationId: 'conv-x' });
    await Promise.resolve();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0]![1]).toEqual(expect.arrayContaining(['--conversation', 'conv-x']));
    procs[0]!.reply('A', 'conv-x');
    await t;
  });
});
