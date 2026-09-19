import { randomUUID } from 'node:crypto';
import type { ApprovalRow, EventKind, Machine, Task, TaskEvent } from '@remote-hands/shared';
import type {
  CompleteTaskInput,
  EventInput,
  FailTaskInput,
  RegisterMachineInput,
  TaskStore,
} from './task-store.js';

export interface MemoryTaskStoreInput {
  machines?: readonly Machine[];
  tasks?: readonly Task[];
  events?: readonly TaskEvent[];
  approvals?: readonly ApprovalRow[];
  now?: () => Date;
}

export class MemoryTaskStore implements TaskStore {
  readonly #machines = new Map<string, Machine>();
  readonly #tasks = new Map<string, Task>();
  readonly #events: TaskEvent[] = [];
  readonly #approvals = new Map<string, ApprovalRow>();
  readonly #decisionResolvers = new Map<string, Array<(approval: ApprovalRow) => void>>();
  readonly #now: () => Date;
  #nextEventId: number;

  constructor(input: MemoryTaskStoreInput = {}) {
    this.#now = input.now ?? (() => new Date());
    for (const machine of input.machines ?? []) {
      this.#machines.set(machine.id, machine);
    }
    for (const task of input.tasks ?? []) {
      this.#tasks.set(task.id, task);
    }
    for (const approval of input.approvals ?? []) {
      this.#approvals.set(approval.id, approval);
    }
    this.#events.push(...(input.events ?? []));
    this.#nextEventId = this.#events.reduce((max, event) => Math.max(max, event.id), 0) + 1;
  }

  async registerMachine(input: RegisterMachineInput): Promise<Machine> {
    const existing = [...this.#machines.values()].find(
      (machine) => machine.user_id === input.userId && machine.name === input.name,
    );
    const createdAt = existing?.created_at ?? this.#timestamp();
    const machine: Machine = {
      id: existing?.id ?? randomUUID(),
      user_id: input.userId,
      name: input.name,
      hostname: input.hostname,
      agy_version: input.agyVersion,
      daemon_version: input.daemonVersion,
      status: existing?.status ?? 'offline',
      last_seen_at: existing?.last_seen_at ?? null,
      created_at: createdAt,
    };

    this.#machines.set(machine.id, machine);
    return machine;
  }

  async getMachine(): Promise<Machine> {
    const first = Array.from(this.#machines.values())[0];
    if (first) return first;
    return this.registerMachine({
      userId: 'default-user',
      name: 'default-machine',
      hostname: 'localhost',
      agyVersion: null,
      daemonVersion: null,
    });
  }

  async heartbeat(machineId: string): Promise<Machine> {
    const machine = this.#requireMachine(machineId);
    const updated: Machine = {
      ...machine,
      status: 'online',
      last_seen_at: this.#timestamp(),
    };
    this.#machines.set(machineId, updated);
    return updated;
  }

  async claimNextTask(machineId: string): Promise<Task | null> {
    const task = [...this.#tasks.values()]
      .filter((candidate) => candidate.machine_id === machineId && candidate.status === 'queued')
      .sort((left, right) => {
        const byCreatedAt = Date.parse(left.created_at) - Date.parse(right.created_at);
        return byCreatedAt === 0 ? left.id.localeCompare(right.id) : byCreatedAt;
      })[0];

    if (task === undefined) return null;

    const claimed: Task = { ...task, status: 'claimed' };
    this.#tasks.set(task.id, claimed);
    return claimed;
  }

  async markTaskRunning(taskId: string): Promise<Task> {
    const task = this.#requireTask(taskId);
    const running: Task = {
      ...task,
      status: 'running',
      started_at: task.started_at ?? this.#timestamp(),
    };
    this.#tasks.set(taskId, running);
    return running;
  }

  async appendEvent<K extends EventKind>(
    taskId: string,
    input: EventInput<K>,
  ): Promise<TaskEvent<K>> {
    const task = this.#requireTask(taskId);
    const event = {
      id: this.#nextEventId,
      task_id: task.id,
      user_id: task.user_id,
      seq: this.eventsForTask(task.id).length,
      created_at: this.#timestamp(),
      kind: input.kind,
      payload: input.payload,
    } as TaskEvent<K>;

    this.#nextEventId += 1;
    this.#events.push(event as TaskEvent);
    return event;
  }

  async completeTask(taskId: string, input: CompleteTaskInput): Promise<Task> {
    const task = this.#requireTask(taskId);
    const completed: Task = {
      ...task,
      status: 'done',
      conversation_id: input.conversationId ?? null,
      result_summary: input.summary,
      error: null,
      finished_at: this.#timestamp(),
    };
    this.#tasks.set(taskId, completed);
    return completed;
  }

  async failTask(taskId: string, input: FailTaskInput): Promise<Task> {
    const task = this.#requireTask(taskId);
    const failed: Task = {
      ...task,
      status: 'failed',
      error: input.error,
      finished_at: this.#timestamp(),
    };
    this.#tasks.set(taskId, failed);
    return failed;
  }

  async getTask(taskId: string): Promise<Task | null> {
    return this.#tasks.get(taskId) ?? null;
  }

  async cancelTask(taskId: string, reason?: string): Promise<Task> {
    const task = this.#requireTask(taskId);
    const cancelled: Task = {
      ...task,
      status: 'cancelled',
      error: reason ?? 'Task cancelled by user',
      finished_at: this.#timestamp(),
    };
    this.#tasks.set(taskId, cancelled);
    return cancelled;
  }

  taskById(taskId: string): Task | null {
    return this.#tasks.get(taskId) ?? null;
  }

  eventsForTask(taskId: string): readonly TaskEvent[] {
    return this.#events.filter((event) => event.task_id === taskId);
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #requireMachine(machineId: string): Machine {
    const machine = this.#machines.get(machineId);
    if (machine === undefined) throw new Error(`Unknown machine: ${machineId}`);
    return machine;
  }

  #requireTask(taskId: string): Task {
    const task = this.#tasks.get(taskId);
    if (task === undefined) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  addApproval(approval: ApprovalRow): void {
    this.#approvals.set(approval.id, approval);
  }

  async listApprovals(taskId: string): Promise<ApprovalRow[]> {
    return [...this.#approvals.values()].filter((a) => a.task_id === taskId);
  }

  async getPendingApproval(taskId: string): Promise<ApprovalRow | null> {
    return [...this.#approvals.values()].find((a) => a.task_id === taskId && a.decision === 'pending') ?? null;
  }

  async decideApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    reason?: string,
  ): Promise<ApprovalRow> {
    const existing = this.#approvals.get(approvalId);
    if (!existing) throw new Error(`Unknown approval: ${approvalId}`);
    const updated: ApprovalRow = {
      ...existing,
      decision,
      decided_at: this.#timestamp(),
      rejection_reason: reason ?? null,
    };
    this.#approvals.set(approvalId, updated);
    const resolvers = this.#decisionResolvers.get(approvalId);
    if (resolvers) {
      for (const res of resolvers) res(updated);
      this.#decisionResolvers.delete(approvalId);
    }
    return updated;
  }

  async waitForApprovalDecision(
    approvalId: string,
    timeoutMs = 600000,
    signal?: AbortSignal,
  ): Promise<ApprovalRow> {
    const current = this.#approvals.get(approvalId);
    if (current && current.decision !== 'pending') return current;

    return new Promise<ApprovalRow>((resolve, reject) => {
      let timer: any = null;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        reject(new Error('Aborted while waiting for approval decision'));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      const onDecision = (approval: ApprovalRow) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(approval);
      };

      const list = this.#decisionResolvers.get(approvalId) ?? [];
      list.push(onDecision);
      this.#decisionResolvers.set(approvalId, list);

      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        const cur = this.#approvals.get(approvalId);
        if (cur && cur.decision !== 'pending') {
          resolve(cur);
        } else {
          reject(new Error('Approval request timed out'));
        }
      }, timeoutMs);
    });
  }

  async markTaskAwaitingApproval(taskId: string): Promise<Task> {
    const task = this.#requireTask(taskId);
    const updated: Task = {
      ...task,
      status: 'awaiting_approval',
    };
    this.#tasks.set(taskId, updated);
    return updated;
  }
}
