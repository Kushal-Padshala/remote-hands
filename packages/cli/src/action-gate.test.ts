import { describe, expect, it, vi } from 'vitest';
import { createActionGate } from './action-gate.js';

describe('createActionGate', () => {
  it('stops an unidentifiable control during an agent task', async () => {
    const gate = createActionGate({ env: {}, taskId: 'task-1' });
    await expect(gate('')).rejects.toThrow(/Cannot verify/);
  });

  it('asks for approval before a risky control and lets it run when approved', async () => {
    const approve = vi.fn().mockResolvedValue(0);
    const gate = createActionGate({ env: {}, taskId: 'task-1', approve });
    await gate('Post');
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]![0]).toEqual(['Press "Post"', '--action=publish', '--risk=high', '--task=task-1']);
  });

  it('stops the action with the rejection reason', async () => {
    const approve = vi.fn(async (_args: string[], ctx: any) => {
      ctx.stderr('Approval rejected by user: wrong account');
      return 1;
    });
    const gate = createActionGate({ env: {}, taskId: 'task-1', approve });
    await expect(gate('Delete repository')).rejects.toThrow(
      'Approval rejected by user: wrong account "Delete repository" was not pressed.',
    );
  });

  it('says the user did not allow it only for a real refusal or no answer, not for a failure to ask', async () => {
    const failing = (message: string) => vi.fn(async (_a: string[], ctx: any) => { ctx.stderr(message); return 1; });
    const refused = createActionGate({ env: {}, taskId: 'task-1', approve: failing('Approval rejected by user.') });
    await expect(refused('Delete')).rejects.toThrow('The user did not allow it.');
    const silent = createActionGate({ env: {}, taskId: 'task-1', approve: failing('Approval request timed out.') });
    await expect(silent('Delete')).rejects.toThrow('The user did not allow it.');
    const broken = createActionGate({ env: {}, taskId: 'task-1', approve: failing('Failed to create approval request: disk full') });
    await expect(broken('Delete')).rejects.not.toThrow('The user did not allow it.');
  });

  it('never writes approval chatter to stdout (the MCP server uses it for JSON-RPC)', async () => {
    const stdout = vi.fn();
    const approve = vi.fn(async (_args: string[], ctx: any) => {
      ctx.stdout('Approval request created');
      return 0;
    });
    await createActionGate({ env: {}, taskId: 'task-1', approve, stdout })('Send');
    expect(stdout).not.toHaveBeenCalled();
  });

  it('lets ordinary controls through without asking', async () => {
    const approve = vi.fn();
    await createActionGate({ env: {}, taskId: 'task-1', approve })('Next');
    expect(approve).not.toHaveBeenCalled();
  });

  it('does not gate outside an agent task', async () => {
    const approve = vi.fn();
    await createActionGate({ env: {}, approve })('Publish');
    expect(approve).not.toHaveBeenCalled();
  });

  it('takes the task from REMOTE_HANDS_TASK_ID and classifies goals', async () => {
    const approve = vi.fn().mockResolvedValue(0);
    await createActionGate({ env: { REMOTE_HANDS_TASK_ID: 'task-9' }, approve })(
      'open Mail and send the draft to the whole team right now please',
      { goal: true },
    );
    expect(approve.mock.calls[0]![0]).toContain('--task=task-9');
    expect(approve.mock.calls[0]![0][0]).toMatch(/^Run "/);
  });
});
