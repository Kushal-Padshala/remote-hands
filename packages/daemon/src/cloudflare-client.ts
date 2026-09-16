import {
  claimTaskResponseSchema,
  appendEventResponseSchema,
  completeTaskResponseSchema,
  failTaskResponseSchema,
  createApprovalResponseSchema,
  decideApprovalResponseSchema,
  taskResponseSchema,
  type TaskRow,
  type TaskEventRow,
  type ApprovalRow,
  type MachineRow,
  type CreateApprovalRequest,
  type DecideApprovalRequest,
  type CompleteTaskRequest,
  type FailTaskRequest,
  type AppendEventRequest,
} from '@remote-hands/shared';

export interface CloudflareClientConfig {
  baseUrl: string;
  sessionToken: string;
  fetchFn?: typeof fetch | undefined;
}

export class ControlPlaneError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

export class CloudflareControlPlaneClient {
  private readonly baseUrl: string;
  private readonly sessionToken: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: CloudflareClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.sessionToken = config.sessionToken;
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.sessionToken}`,
    };

    const init: RequestInit = {
      method,
      headers,
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await this.fetchFn(url, init);

    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }

    if (!res.ok) {
      const message =
        (json && typeof json === 'object' && 'error' in json && typeof json.error === 'string'
          ? json.error
          : res.statusText) || `Request failed with status ${res.status}`;
      throw new ControlPlaneError(message, res.status, json);
    }

    return json as T;
  }

  async claimNextTask(machineId: string): Promise<TaskRow | null> {
    const data = await this.request<unknown>('/tasks/claim', 'POST', {
      machine_id: machineId,
    });
    const parsed = claimTaskResponseSchema.parse(data);
    return parsed.task;
  }

  async getTask(taskId: string): Promise<TaskRow> {
    const data = await this.request<unknown>(`/tasks/${taskId}`, 'GET');
    const parsed = taskResponseSchema.parse(data);
    return parsed.task;
  }

  async markTaskRunning(taskId: string): Promise<TaskRow> {
    const data = await this.request<unknown>(`/tasks/${taskId}/running`, 'POST');
    const parsed = taskResponseSchema.parse(data);
    return parsed.task;
  }

  async appendEvent(taskId: string, input: AppendEventRequest): Promise<TaskEventRow> {
    const data = await this.request<unknown>(`/tasks/${taskId}/events`, 'POST', input);
    const parsed = appendEventResponseSchema.parse(data);
    return parsed.event;
  }

  async completeTask(taskId: string, input: CompleteTaskRequest): Promise<TaskRow> {
    const data = await this.request<unknown>(`/tasks/${taskId}/complete`, 'POST', input);
    const parsed = completeTaskResponseSchema.parse(data);
    return parsed.task;
  }

  async failTask(taskId: string, input: FailTaskRequest): Promise<TaskRow> {
    const data = await this.request<unknown>(`/tasks/${taskId}/fail`, 'POST', input);
    const parsed = failTaskResponseSchema.parse(data);
    return parsed.task;
  }

  async createApproval(input: CreateApprovalRequest): Promise<ApprovalRow> {
    const data = await this.request<unknown>('/approvals', 'POST', input);
    const parsed = createApprovalResponseSchema.parse(data);
    return parsed.approval;
  }

  async decideApproval(approvalId: string, input: DecideApprovalRequest): Promise<ApprovalRow> {
    const data = await this.request<unknown>(`/approvals/${approvalId}/decision`, 'POST', input);
    const parsed = decideApprovalResponseSchema.parse(data);
    return parsed.approval;
  }

  async heartbeat(machineId: string): Promise<MachineRow> {
    const data = await this.request<{ machine: MachineRow }>(
      `/machines/${machineId}/heartbeat`,
      'POST',
    );
    return data.machine;
  }

  async getMachine(machineId: string): Promise<MachineRow> {
    const data = await this.request<{ machine: MachineRow }>(`/machines/${machineId}`, 'GET');
    return data.machine;
  }
}
