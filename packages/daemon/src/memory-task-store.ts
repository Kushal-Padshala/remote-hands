import { randomUUID } from 'node:crypto';
import type { EventKind, Machine, Task, TaskEvent } from '@remote-hands/shared';
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
  now?: () => Date;
}

export class MemoryTaskStore implements TaskStore {
  readonly #machines = new Map<string, Machine>();
  readonly #tasks = new Map<string, Task>();
  readonly #events: TaskEvent[] = [];
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
}
