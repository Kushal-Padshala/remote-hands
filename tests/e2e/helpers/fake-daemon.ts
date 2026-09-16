import type { TaskRow, ApprovalRow } from '@remote-hands/shared';
import { CloudflareControlPlaneClient } from '../../../packages/daemon/src/cloudflare-client.js';

export interface FakeDaemonOptions {
  client: CloudflareControlPlaneClient;
  machineId: string;
}

export class FakeDaemon {
  private client: CloudflareControlPlaneClient;
  private machineId: string;

  constructor(options: FakeDaemonOptions) {
    this.client = options.client;
    this.machineId = options.machineId;
  }

  async runOnce(): Promise<{
    claimed: boolean;
    task?: TaskRow | undefined;
    approval?: ApprovalRow | undefined;
  }> {
    const task = await this.client.claimNextTask(this.machineId);
    if (!task) {
      return { claimed: false };
    }

    await this.client.markTaskRunning(task.id);
    await this.client.appendEvent(task.id, {
      kind: 'status',
      payload: { status: 'running' },
    });

    await this.client.appendEvent(task.id, {
      kind: 'browser_action',
      payload: {
        action: 'navigate',
        label: 'Navigated to WordPress admin',
        url: 'https://example.com/wp-admin',
      },
    });

    const approval = await this.client.createApproval({
      task_id: task.id,
      action_kind: 'publish',
      summary: 'Publish privacy policy page',
      risk: 'high',
      tool_payload: { post_title: 'Privacy Policy' },
    });

    return {
      claimed: true,
      task,
      approval,
    };
  }

  async finishApprovedTask(taskId: string): Promise<TaskRow> {
    await this.client.appendEvent(taskId, {
      kind: 'result',
      payload: { summary: 'Added privacy policy page' },
    });

    return await this.client.completeTask(taskId, {
      summary: 'Added privacy policy page',
    });
  }
}
