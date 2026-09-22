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
  if (typeof window !== 'undefined') {
    try {
      const params = new URLSearchParams(window.location.search);
      const queryApi = params.get('api');
      if (queryApi && queryApi.trim().length > 0) {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('rh_api_url', queryApi.trim().replace(/\/+$/, ''));
        }
        return queryApi.trim().replace(/\/+$/, '');
      }
    } catch {}
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
    if (host.includes('pages.dev') || host.includes('workers.dev')) {
      return 'https://remote-hands-backend.remote-hands-cloudflare.workers.dev';
    }
    return window.location.origin;
  }
  return 'https://remote-hands-backend.remote-hands-cloudflare.workers.dev';
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
      if (res.status === 401 && typeof localStorage !== 'undefined') {
        try {
          localStorage.removeItem('rh_token');
        } catch {}
      }
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

  async listTasks(options?: { machine_id?: string; conversation_id?: string }): Promise<TaskRow[]> {
    const params = new URLSearchParams();
    if (options?.machine_id) {
      params.set('machine_id', options.machine_id);
    }
    if (options?.conversation_id) {
      params.set('conversation_id', options.conversation_id);
    }
    const query = params.toString() ? `?${params.toString()}` : '';
    const res = await this.request<{ tasks?: TaskRow[] }>(`/tasks${query}`, 'GET');
    return res?.tasks ?? [];
  }

  async createTask(params: {
    machine_id: string;
    prompt: string;
    kind?: TaskKind | undefined;
    mode?: TaskMode | undefined;
    conversation_id?: string | undefined;
    workspace_path?: string | null | undefined;
    model?: string | null | undefined;
    effort?: string | null | undefined;
  }): Promise<TaskRow> {
    const res = await this.request<{ task: TaskRow }>('/tasks', 'POST', params);
    return res.task;
  }

  async getTask(taskId: string): Promise<TaskRow> {
    const res = await this.request<{ task: TaskRow }>(`/tasks/${taskId}`, 'GET');
    return res.task;
  }

  async cancelTask(taskId: string, reason?: string): Promise<TaskRow> {
    const res = await this.request<{ task: TaskRow }>(`/tasks/${taskId}/cancel`, 'POST', { reason });
    return res.task;
  }

  async listEvents(taskId: string): Promise<TaskEventRow[]> {
    const res = await this.request<{ events: TaskEventRow[] }>(`/tasks/${taskId}/events`, 'GET');
    return res.events;
  }

  async decideApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    reason?: string | null | undefined,
  ): Promise<ApprovalRow> {
    const res = await this.request<{ approval: ApprovalRow }>(
      `/approvals/${approvalId}/decision`,
      'POST',
      { decision, ...(reason ? { reason } : {}) },
    );
    return res.approval;
  }

  async getApproval(approvalId: string): Promise<{ approval: ApprovalRow }> {
    return await this.request<{ approval: ApprovalRow }>(`/approvals/${approvalId}`, 'GET');
  }

  async listTaskApprovals(taskId: string): Promise<ApprovalRow[]> {
    const res = await this.request<{ approvals?: ApprovalRow[] }>(`/tasks/${taskId}/approvals`, 'GET');
    return res?.approvals ?? [];
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
