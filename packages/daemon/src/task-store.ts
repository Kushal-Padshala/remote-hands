import type {
  EventKind,
  EventPayload,
  Machine,
  Task,
  TaskEvent,
} from '@remote-hands/shared';

export interface RegisterMachineInput {
  userId: string;
  name: string;
  hostname: string;
  agyVersion: string | null;
  daemonVersion: string | null;
}

export type EventInput<K extends EventKind = EventKind> = {
  [Kind in K]: {
    kind: Kind;
    payload: EventPayload<Kind>;
  };
}[K];

export interface CompleteTaskInput {
  summary: string;
  conversationId?: string | null;
}

export interface FailTaskInput {
  error: string;
}

export interface TaskStore {
  registerMachine(input: RegisterMachineInput): Promise<Machine>;
  heartbeat(machineId: string): Promise<Machine>;
  claimNextTask(machineId: string): Promise<Task | null>;
  markTaskRunning(taskId: string): Promise<Task>;
  appendEvent<K extends EventKind>(taskId: string, input: EventInput<K>): Promise<TaskEvent<K>>;
  completeTask(taskId: string, input: CompleteTaskInput): Promise<Task>;
  failTask(taskId: string, input: FailTaskInput): Promise<Task>;
  pushFrame?(taskId: string, frame: { jpegBase64: string; capturedAt: string }): Promise<void>;
}

