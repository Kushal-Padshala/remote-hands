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

/** The agent task an action belongs to: REMOTE_HANDS_TASK_ID, then the daemon's active task. */
export function activeTaskId(context: ActionGateContext = {}): string | null {
  const env = context.env ?? process.env;
  return context.taskId ?? env.REMOTE_HANDS_TASK_ID ?? readActiveTask();
}

/**
 * Enforces the approval rule in the tools themselves: while an agent task is running, pressing
 * a control that publishes, sends, pays, deletes or deploys waits for the phone, and a
 * rejection (or timeout) stops the action. Outside a task (a person using `rh` directly)
 * nothing is gated.
 */
export function createActionGate(context: ActionGateContext = {}): ActionGate {
  return async (label, opts) => {
    const taskId = activeTaskId(context);
    if (!taskId) return;
    if (!label.trim()) throw new Error('Cannot verify the control label; action was not pressed. Take a fresh snapshot and retry.');
    const action = opts?.kind ?? classifyRiskyAction(label, opts);
    if (!action) return;
    const verb = opts?.goal || action === 'shell' ? 'Run' : 'Press';

    const reasons: string[] = [];
    const approve = context.approve ?? approveCommand;
    const code = await approve(
      [`${verb} "${label.trim()}"`, `--action=${action}`, '--risk=high', `--task=${taskId}`],
      {
        ...context,
        // Never stdout: the MCP server speaks JSON-RPC on it.
        stdout: () => {},
        stderr: (msg) => reasons.push(msg),
      },
    );
    if (code !== 0) {
      throw new Error(`${reasons.join(' ') || 'Approval was not granted.'} "${label.trim()}" was not ${verb === 'Run' ? 'run' : 'pressed'}.`);
    }
  };
}
