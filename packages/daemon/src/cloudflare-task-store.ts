import type {
  EventKind,
  EventPayload,
  Machine,
  MachineRow,
  Task,
  TaskRow,
  TaskEvent,
  TaskEventRow,
} from '@remote-hands/shared';
import type { CloudflareControlPlaneClient } from './cloudflare-client.js';
import type {
  CompleteTaskInput,
  EventInput,
  FailTaskInput,
  RegisterMachineInput,
  TaskStore,
} from './task-store.js';

export interface CloudflareTaskStoreOptions {
  client: CloudflareControlPlaneClient;
  machineId: string;
}

function toMachine(row: MachineRow): Machine {
  return {
    id: row.id,
    user_id: row.owner_id,
    name: row.name,
    hostname: row.hostname,
    daemon_version: row.daemon_version,
    agy_version: row.agy_version,
    status: row.status,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
  };
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    user_id: row.owner_id,
    machine_id: row.machine_id,
    prompt: row.prompt,
    kind: row.kind,
    workspace_path: row.workspace_path,
    model: row.model,
    effort: row.effort,
    mode: row.mode,
    status: row.status,
    conversation_id: row.conversation_id,
    parent_task_id: row.parent_task_id,
    result_summary: row.result_summary,
    error: row.error,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

function toTaskEvent<K extends EventKind>(row: TaskEventRow): TaskEvent<K> {
  return {
    id: row.id,
    task_id: row.task_id,
    user_id: row.owner_id,
    seq: row.seq,
    kind: row.kind as K,
    payload: row.payload as EventPayload<K>,
    created_at: row.created_at,
  };
}

export class CloudflareTaskStore implements TaskStore {
  private readonly client: CloudflareControlPlaneClient;
  private readonly machineId: string;

  constructor(options: CloudflareTaskStoreOptions) {
    this.client = options.client;
    this.machineId = options.machineId;
  }

  async registerMachine(_input: RegisterMachineInput): Promise<Machine> {
    const row = await this.client.heartbeat(this.machineId);
    return toMachine(row);
  }

  async heartbeat(machineId: string): Promise<Machine> {
    const row = await this.client.heartbeat(machineId);
    return toMachine(row);
  }

  async claimNextTask(machineId: string): Promise<Task | null> {
    const row = await this.client.claimNextTask(machineId);
    return row ? toTask(row) : null;
  }

  async markTaskRunning(taskId: string): Promise<Task> {
    const row = await this.client.markTaskRunning(taskId);
    return toTask(row);
  }

  async appendEvent<K extends EventKind>(
    taskId: string,
    input: EventInput<K>,
  ): Promise<TaskEvent<K>> {
    const row = await this.client.appendEvent(taskId, input as any);
    return toTaskEvent<K>(row);
  }

  async completeTask(taskId: string, input: CompleteTaskInput): Promise<Task> {
    const row = await this.client.completeTask(taskId, {
      summary: input.summary,
      conversation_id: input.conversationId ?? undefined,
    });
    return toTask(row);
  }

  async failTask(taskId: string, input: FailTaskInput): Promise<Task> {
    const row = await this.client.failTask(taskId, {
      error: input.error,
    });
    return toTask(row);
  }

  async getTask(taskId: string): Promise<Task | null> {
    try {
      const row = await this.client.getTask(taskId);
      return toTask(row);
    } catch {
      return null;
    }
  }

  async cancelTask(taskId: string, reason?: string): Promise<Task> {
    const row = await this.client.cancelTask(taskId, reason);
    return toTask(row);
  }

  async pushFrame(taskId: string, frame: { jpegBase64: string; capturedAt: string }): Promise<void> {
    await this.client.pushFrame(taskId, frame.jpegBase64, frame.capturedAt);
  }
}
