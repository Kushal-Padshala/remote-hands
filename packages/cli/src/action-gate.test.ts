import { describe, expect, it, vi } from 'vitest';
import { createActionGate } from './action-gate.js';

describe('createActionGate', () => {
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
