import {
  type MachineRow,
  type TaskRow,
  type TaskEventRow,
  type ApprovalRow,
  type TaskKind,
  type TaskMode,
} from '@remote-hands/shared';

function resolveDefaultBaseUrl(providedUrl?: string): string {
  if (providedUrl && providedUrl.trim().length > 0) {
    return providedUrl.replace(/\/+$/, '');
  }
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem('rh_api_url');
    if (stored && stored.trim().length > 0) {
      return stored.replace(/\/+$/, '');
    }
  }
  const envUrl = (import.meta as any).env?.VITE_REMOTE_HANDS_API_URL;
  if (envUrl && typeof envUrl === 'string' && envUrl.trim().length > 0) {
    return envUrl.replace(/\/+$/, '');
  }
  if (typeof window !== 'undefined') {
    const host = window.location.host;
    if (host.includes('remote-hands-web.')) {
      return window.location.origin.replace('remote-hands-web.', 'remote-hands-backend.');
    }
  }
  return '';
}

export class WebApiClient {
  private baseUrl: string;
  private token: string | null;

  constructor(baseUrl?: string, token?: string | null) {
    this.baseUrl = resolveDefaultBaseUrl(baseUrl);
    this.token = token ?? (typeof localStorage !== 'undefined' ? localStorage.getItem('rh_token') : null);
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, '');
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('rh_api_url', this.baseUrl);
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
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
    const effectiveBase = this.baseUrl || resolveDefaultBaseUrl();
    const url = `${effectiveBase}${path.startsWith('/') ? path : `/${path}`}`;
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
    const contentType = res.headers.get('content-type') || '';
    let json: any = null;
    if (contentType.includes('application/json')) {
      try {
        json = await res.json();
      } catch {
        json = null;
      }
    }

    if (!res.ok) {
      const msg = json?.error || res.statusText || `Request failed with ${res.status}`;
      throw new Error(msg);
    }
    if (json === null) {
      throw new Error(`Expected JSON response from ${url}, but received ${contentType || 'text'}`);
    }
    return json as T;
  }

  async listMachines(): Promise<MachineRow[]> {
    const res = await this.request<{ machines?: MachineRow[] }>('/machines', 'GET');
    return res?.machines ?? [];
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
    const effectiveBase = this.baseUrl || resolveDefaultBaseUrl();
    const protocol = effectiveBase.startsWith('https:') ? 'wss:' : 'ws:';
    const host = effectiveBase ? new URL(effectiveBase).host : window.location.host;
    const tokenQuery = this.token ? `?token=${encodeURIComponent(this.token)}` : '';
    const url = `${protocol}//${host}/ws/tasks/${taskId}${tokenQuery}`;
    return new WebSocket(url);
  }
}

export const apiClient = new WebApiClient();
