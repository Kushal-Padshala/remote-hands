import {
  claimTaskResponseSchema,
  appendEventResponseSchema,
  completeTaskResponseSchema,
  failTaskResponseSchema,
  cancelTaskResponseSchema,
  createApprovalResponseSchema,
  decideApprovalResponseSchema,
  listApprovalsResponseSchema,
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

    const maxRetries = 3;
    let lastError: any = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const res = await this.fetchFn(url, init);

        let json: any = null;
        try {
          json = await res.json();
        } catch {
          json = null;
        }

        if (!res.ok) {
          if (res.status >= 500 && attempt < maxRetries - 1) {
            await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
            continue;
          }
          const message =
            (json && typeof json === 'object' && 'error' in json && typeof json.error === 'string'
              ? json.error
              : res.statusText) || `Request failed with status ${res.status}`;
          throw new ControlPlaneError(message, res.status, json);
        }

        return json as T;
      } catch (err: any) {
        if (err instanceof ControlPlaneError) {
          throw err;
        }
        lastError = err;
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
          continue;
        }
      }
    }

    throw lastError;
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

  async cancelTask(taskId: string, reason?: string): Promise<TaskRow> {
    const data = await this.request<unknown>(`/tasks/${taskId}/cancel`, 'POST', { reason });
    const parsed = cancelTaskResponseSchema.parse(data);
    return parsed.task;
  }

  async createApproval(input: CreateApprovalRequest): Promise<ApprovalRow> {
    const data = await this.request<unknown>('/approvals', 'POST', input);
    const parsed = createApprovalResponseSchema.parse(data);
    return parsed.approval;
  }

  async getApproval(approvalId: string): Promise<ApprovalRow> {
    const data = await this.request<unknown>(`/approvals/${approvalId}`, 'GET');
    const parsed = createApprovalResponseSchema.parse(data);
    return parsed.approval;
  }

  async decideApproval(approvalId: string, input: DecideApprovalRequest): Promise<ApprovalRow> {
    const data = await this.request<unknown>(`/approvals/${approvalId}/decision`, 'POST', input);
    const parsed = decideApprovalResponseSchema.parse(data);
    return parsed.approval;
  }

  async listTaskApprovals(taskId: string): Promise<ApprovalRow[]> {
    const data = await this.request<unknown>(`/tasks/${taskId}/approvals`, 'GET');
    const parsed = listApprovalsResponseSchema.parse(data);
    return parsed.approvals;
  }

  async markTaskAwaitingApproval(taskId: string): Promise<TaskRow> {
    const data = await this.request<unknown>(`/tasks/${taskId}/awaiting_approval`, 'POST');
    const parsed = taskResponseSchema.parse(data);
    return parsed.task;
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

  async pushFrame(taskId: string, jpegBase64: string, capturedAt?: string): Promise<void> {
    await this.request<{ ok: boolean }>(`/tasks/${taskId}/frames`, 'POST', {
      jpeg_base64: jpegBase64,
      captured_at: capturedAt ?? new Date().toISOString(),
    });
  }
}
