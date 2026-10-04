import { readActiveTask, type ActionGate } from '@remote-hands/daemon';
import { classifyRiskyAction } from '@remote-hands/shared';
import { approveCommand } from './commands/approve.js';
import type { CommandContext } from './commands/setup.js';

export interface ActionGateContext extends CommandContext {
  /** Task to file approvals under; defaults to REMOTE_HANDS_TASK_ID, then the daemon's active task. */
  taskId?: string | undefined;
  /** Replaces `rh approve` (tests). Resolves to its exit code. */
  approve?: ((args: string[], context: CommandContext) => Promise<number>) | undefined;
}

/**
 * Enforces the approval rule in the tools themselves: while an agent task is running, pressing
 * a control that publishes, sends, pays, deletes or deploys waits for the phone, and a
 * rejection (or timeout) stops the action. Outside a task (a person using `rh` directly)
 * nothing is gated.
 */
export function createActionGate(context: ActionGateContext = {}): ActionGate {
  return async (label, opts) => {
    const action = classifyRiskyAction(label, opts);
    if (!action) return;
    const env = context.env ?? process.env;
    const taskId = context.taskId ?? env.REMOTE_HANDS_TASK_ID ?? readActiveTask();
    if (!taskId) return;

    const reasons: string[] = [];
    const approve = context.approve ?? approveCommand;
    const code = await approve(
      [`${opts?.goal ? 'Run' : 'Press'} "${label.trim()}"`, `--action=${action}`, '--risk=high', `--task=${taskId}`],
      {
        ...context,
        // Never stdout: the MCP server speaks JSON-RPC on it.
        stdout: () => {},
        stderr: (msg) => reasons.push(msg),
      },
    );
    if (code !== 0) {
      throw new Error(`${reasons.join(' ') || 'Approval was not granted.'} "${label.trim()}" was not pressed.`);
    }
  };
}
