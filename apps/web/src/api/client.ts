import {
  type MachineRow,
  type TaskRow,
  type TaskEventRow,
  type ApprovalRow,
  type TaskKind,
  type TaskMode,
} from '@remote-hands/shared';

export class WebApiClient {
  private baseUrl: string;
  private token: string | null;

  constructor(baseUrl?: string, token?: string | null) {
    this.baseUrl = (baseUrl ?? (import.meta as any).env?.VITE_REMOTE_HANDS_API_URL ?? '').replace(
      /\/+$/,
      '',
    );
    this.token = token ?? (typeof localStorage !== 'undefined' ? localStorage.getItem('rh_token') : null);
  }

  setToken(token: string): void {
    this.token = token;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('rh_token', token);
    }
  }

  getToken(): string | null {
    return this.token;
  }

  private async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    const init: RequestInit = {
      method,
      headers,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg = json?.error || res.statusText || `Request failed with ${res.status}`;
      throw new Error(msg);
    }
    return json as T;
  }

  async listMachines(): Promise<MachineRow[]> {
    const res = await this.request<{ machines: MachineRow[] }>('/machines', 'GET');
    return res.machines;
  }

  async createTask(params: {
    machine_id: string;
    prompt: string;
    kind?: TaskKind | undefined;
    mode?: TaskMode | undefined;
  }): Promise<TaskRow> {
    const res = await this.request<{ task: TaskRow }>('/tasks', 'POST', params);
    return res.task;
  }

  async getTask(taskId: string): Promise<TaskRow> {
    const res = await this.request<{ task: TaskRow }>(`/tasks/${taskId}`, 'GET');
    return res.task;
  }

  async listEvents(taskId: string): Promise<TaskEventRow[]> {
    const res = await this.request<{ events: TaskEventRow[] }>(`/tasks/${taskId}/events`, 'GET');
    return res.events;
  }

  async decideApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
  ): Promise<ApprovalRow> {
    const res = await this.request<{ approval: ApprovalRow }>(
      `/approvals/${approvalId}/decision`,
      'POST',
      { decision },
    );
    return res.approval;
  }

  createTaskWebSocket(taskId: string): WebSocket {
    const protocol = this.baseUrl.startsWith('https:') ? 'wss:' : 'ws:';
    const host = this.baseUrl ? new URL(this.baseUrl).host : window.location.host;
    const tokenQuery = this.token ? `?token=${encodeURIComponent(this.token)}` : '';
    const url = `${protocol}//${host}/ws/tasks/${taskId}${tokenQuery}`;
    return new WebSocket(url);
  }
}

export const apiClient = new WebApiClient();
