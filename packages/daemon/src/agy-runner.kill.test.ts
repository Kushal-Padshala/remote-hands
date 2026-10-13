import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import type { Task } from '@remote-hands/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessAgentRunner, getDefaultRemoteHandsReminder, getDefaultRemoteHandsSystemPrompt } from './agy-runner.js';
import { HermesBrain } from './hermes-brain.js';
import { computerPrompt, WINDOWS_COMPUTER_REMINDER } from './computer/prompt.js';
import { killWindowsProcessTree } from './system/windows.js';

vi.mock('node:child_process', async (original) => ({ ...(await original<typeof import('node:child_process')>()), spawn: vi.fn() }));
vi.mock('./system/windows.js', async (original) => ({ ...(await original<typeof import('./system/windows.js')>()), killWindowsProcessTree: vi.fn(() => true) }));

const task: Task = {
  id: '33333333-3333-4333-8333-333333333333',
  user_id: '11111111-1111-4111-8111-111111111111',
  machine_id: '22222222-2222-4222-8222-222222222222',
  prompt: 'do it',
  kind: 'browser',
  workspace_path: null,
  model: 'gemini-3.8-flash',
  effort: 'low',
  mode: 'default',
  status: 'running',
  conversation_id: null,
  parent_task_id: null,
  result_summary: null,
  error: null,
  created_at: '2026-09-16T14:00:00.000Z',
  started_at: '2026-09-16T14:01:00.000Z',
  finished_at: null,
};

function fakeProcess() {
  const proc = new EventEmitter() as EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
  proc.pid = 5000;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  return proc;
}

describe('the cold agent process on Windows', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let home: string;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.mocked(killWindowsProcessTree).mockClear();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-kill-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', platform);
    fs.rmSync(home, { recursive: true, force: true });
  });

  const runner = () => new ProcessAgentRunner('agy', undefined, new HermesBrain(home));

  it('ends the whole tree once on cancel, and not again after the agent has exited', async () => {
    const proc = fakeProcess();
    vi.mocked(spawn).mockReturnValue(proc as never);
    const controller = new AbortController();
    const run = runner().run(task, undefined, controller.signal);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    controller.abort();
    expect(killWindowsProcessTree).toHaveBeenCalledTimes(1);
    expect(killWindowsProcessTree).toHaveBeenCalledWith(5000);
    // the agent ends right away; the delayed second attempt must find nothing to do
    proc.emit('exit', 1, null);
    proc.emit('close', 1);
    await run.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1000);
    expect(killWindowsProcessTree).toHaveBeenCalledTimes(1);
  });

  it('ignores a later abort of the shared signal once the agent has finished', async () => {
    const proc = fakeProcess();
    vi.mocked(spawn).mockReturnValue(proc as never);
    const controller = new AbortController();
    const run = runner().run(task, undefined, controller.signal);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    proc.emit('exit', 0, null);
    proc.emit('close', 0);
    await run.catch(() => undefined);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    expect(killWindowsProcessTree).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('tells the person in plain words when the agent program cannot be started', async () => {
    const proc = fakeProcess();
    vi.mocked(spawn).mockReturnValue(proc as never);
    const run = runner().run(task);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    proc.emit('error', Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }));
    await expect(run).rejects.toThrow('Remote Hands could not start the agent program (agy). Run "rh setup" to install or repair it.');
  });
});

describe('the default agent instructions', () => {
  it('are the browser-only ones off the Mac, for the first message and for a continued conversation', () => {
    expect(getDefaultRemoteHandsSystemPrompt('win32')).toBe(computerPrompt('win32'));
    expect(getDefaultRemoteHandsReminder('win32')).toBe(WINDOWS_COMPUTER_REMINDER);
    for (const text of [getDefaultRemoteHandsSystemPrompt('win32'), getDefaultRemoteHandsReminder('win32')]) {
      expect(text).not.toMatch(/ax-action|osascript|Accessibility|desktop_/);
    }
  });

  it('are the Mac ones, unchanged, on a Mac', () => {
    expect(getDefaultRemoteHandsSystemPrompt('darwin')).toContain('rh desktop ax-action');
    expect(getDefaultRemoteHandsReminder('darwin')).toContain('rh desktop ax-action');
  });
});
