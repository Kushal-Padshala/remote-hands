import { describe, expect, it, vi } from 'vitest';
import {
  CloudflareControlPlaneClient,
  ControlPlaneError,
} from './cloudflare-client.js';

describe('CloudflareControlPlaneClient', () => {
  it('sends Authorization Bearer header and content-type', async () => {
    let capturedRequest: { url: string; headers: Record<string, string>; method: string } | null = null;

    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers: Record<string, string> = {};
      if (init?.headers) {
        new Headers(init.headers).forEach((value, key) => {
          headers[key] = value;
        });
      }
      capturedRequest = {
        url,
        headers,
        method: init?.method ?? 'GET',
      };
      return new Response(JSON.stringify({ task: null }), { status: 200 });
    });

    const client = new CloudflareControlPlaneClient({
      baseUrl: 'https://api.example.com',
      sessionToken: 'test-session-token-1234567890',
      fetchFn: fakeFetch as unknown as typeof fetch,
    });

    await client.claimNextTask('11111111-1111-4111-8111-111111111111');

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest?.url).toBe('https://api.example.com/tasks/claim');
    expect(capturedRequest?.method).toBe('POST');
    expect(capturedRequest?.headers['authorization']).toBe('Bearer test-session-token-1234567890');
    expect(capturedRequest?.headers['content-type']).toBe('application/json');
  });

  it('posts event matching api schema', async () => {
    let capturedBody: unknown = null;

    const fakeFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          event: {
            id: 1,
            task_id: '22222222-2222-4222-8222-222222222222',
            owner_id: '11111111-1111-4111-8111-111111111111',
            seq: 0,
            kind: 'agent_text',
            payload: { text: 'Hello world\n' },
            created_at: new Date().toISOString(),
          },
        }),
        { status: 201 },
      );
    });

    const client = new CloudflareControlPlaneClient({
      baseUrl: 'https://api.example.com',
      sessionToken: 'token-abc',
      fetchFn: fakeFetch as unknown as typeof fetch,
    });

    const event = await client.appendEvent('22222222-2222-4222-8222-222222222222', {
      kind: 'agent_text',
      payload: { text: 'Hello world\n' },
    });

    expect(capturedBody).toEqual({
      kind: 'agent_text',
      payload: { text: 'Hello world\n' },
    });
    expect(event.id).toBe(1);
    expect(event.seq).toBe(0);
  });

  it('throws ControlPlaneError on non-2xx response', async () => {
    const fakeFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'Unauthorized session' }), {
        status: 401,
        statusText: 'Unauthorized',
      });
    });

    const client = new CloudflareControlPlaneClient({
      baseUrl: 'https://api.example.com',
      sessionToken: 'bad-token',
      fetchFn: fakeFetch as unknown as typeof fetch,
    });

    await expect(client.claimNextTask('11111111-1111-4111-8111-111111111111')).rejects.toThrow(
      ControlPlaneError,
    );
  });

  it('handles completeTask, failTask, createApproval, and decideApproval', async () => {
    const urls: string[] = [];
    const methods: string[] = [];

    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      urls.push(url);
      methods.push(init?.method ?? 'GET');

      if (url.includes('/complete')) {
        return new Response(
          JSON.stringify({
            task: {
              id: '33333333-3333-4333-8333-333333333333',
              owner_id: '11111111-1111-4111-8111-111111111111',
              machine_id: '22222222-2222-4222-8222-222222222222',
              prompt: 'test',
              kind: 'browser',
              workspace_path: null,
              model: null,
              effort: null,
              mode: 'default',
              status: 'done',
              conversation_id: null,
              parent_task_id: null,
              result_summary: 'Done summary',
              error: null,
              created_at: new Date().toISOString(),
              started_at: new Date().toISOString(),
              finished_at: new Date().toISOString(),
            },
          }),
          { status: 200 },
        );
      }

      if (url.includes('/fail')) {
        return new Response(
          JSON.stringify({
            task: {
              id: '33333333-3333-4333-8333-333333333333',
              owner_id: '11111111-1111-4111-8111-111111111111',
              machine_id: '22222222-2222-4222-8222-222222222222',
              prompt: 'test',
              kind: 'browser',
              workspace_path: null,
              model: null,
              effort: null,
              mode: 'default',
              status: 'failed',
              conversation_id: null,
              parent_task_id: null,
              result_summary: null,
              error: 'Failed message',
              created_at: new Date().toISOString(),
              started_at: new Date().toISOString(),
              finished_at: new Date().toISOString(),
            },
          }),
          { status: 200 },
        );
      }

      if (url.endsWith('/approvals')) {
        return new Response(
          JSON.stringify({
            approval: {
              id: '44444444-4444-4444-8444-444444444444',
              task_id: '33333333-3333-4333-8333-333333333333',
              owner_id: '11111111-1111-4111-8111-111111111111',
              action_kind: 'publish',
              summary: 'Publish post',
              risk: 'high',
              tool_payload: {},
              frame_path: null,
              decision: 'pending',
              decided_at: null,
              expires_at: new Date(Date.now() + 60000).toISOString(),
              created_at: new Date().toISOString(),
            },
          }),
          { status: 201 },
        );
      }

      if (url.includes('/decision')) {
        return new Response(
          JSON.stringify({
            approval: {
              id: '44444444-4444-4444-8444-444444444444',
              task_id: '33333333-3333-4333-8333-333333333333',
              owner_id: '11111111-1111-4111-8111-111111111111',
              action_kind: 'publish',
              summary: 'Publish post',
              risk: 'high',
              tool_payload: {},
              frame_path: null,
              decision: 'approved',
              decided_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 60000).toISOString(),
              created_at: new Date().toISOString(),
            },
          }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = new CloudflareControlPlaneClient({
      baseUrl: 'https://api.example.com',
      sessionToken: 'token-xyz',
      fetchFn: fakeFetch as unknown as typeof fetch,
    });

    const completed = await client.completeTask('33333333-3333-4333-8333-333333333333', {
      summary: 'Done summary',
    });
    expect(completed.status).toBe('done');

    const failed = await client.failTask('33333333-3333-4333-8333-333333333333', {
      error: 'Failed message',
    });
    expect(failed.status).toBe('failed');

    const approval = await client.createApproval({
      task_id: '33333333-3333-4333-8333-333333333333',
      action_kind: 'publish',
      summary: 'Publish post',
      risk: 'high',
      tool_payload: {},
    });
    expect(approval.decision).toBe('pending');

    const decided = await client.decideApproval('44444444-4444-4444-8444-444444444444', {
      decision: 'approved',
    });
    expect(decided.decision).toBe('approved');
  });

  it('posts frame to tasks/:id/frames', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;

    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = input.toString();
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = new CloudflareControlPlaneClient({
      baseUrl: 'https://api.example.com',
      sessionToken: 'test-session-token',
      fetchFn: fakeFetch as unknown as typeof fetch,
    });

    await client.pushFrame('task-123', 'fake-jpeg-base64', '2026-09-17T00:00:00.000Z');
    expect(capturedUrl).toBe('https://api.example.com/tasks/task-123/frames');
    expect(capturedBody).toEqual({
      jpeg_base64: 'fake-jpeg-base64',
      captured_at: '2026-09-17T00:00:00.000Z',
    });
  });

  it('retries on transient network error and succeeds on second attempt', async () => {
    let attempts = 0;
    const fakeFetch = vi.fn(async () => {
      attempts++;
      if (attempts === 1) {
        throw new TypeError('fetch failed');
      }
      return new Response(
        JSON.stringify({
          machine: {
            id: 'mach-1',
            owner_id: 'user-1',
            name: 'laptop',
            hostname: 'laptop.local',
            daemon_version: '0.1.0',
            agy_version: '0.2.0',
            status: 'online',
            last_seen_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        }),
        { status: 200 },
      );
    });

    const client = new CloudflareControlPlaneClient({
      baseUrl: 'https://api.example.com',
      sessionToken: 'test-token',
      fetchFn: fakeFetch as unknown as typeof fetch,
    });

    const res = await client.heartbeat('mach-1');
    expect(attempts).toBe(2);
    expect(res.id).toBe('mach-1');
  });

  it('retries on 502 Bad Gateway and succeeds on subsequent attempt', async () => {
    let attempts = 0;
    const fakeFetch = vi.fn(async () => {
      attempts++;
      if (attempts === 1) {
        return new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' });
      }
      return new Response(
        JSON.stringify({
          machine: {
            id: 'mach-1',
            owner_id: 'user-1',
            name: 'laptop',
            hostname: 'laptop.local',
            daemon_version: '0.1.0',
            agy_version: '0.2.0',
            status: 'online',
            last_seen_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        }),
        { status: 200 },
      );
    });

    const client = new CloudflareControlPlaneClient({
      baseUrl: 'https://api.example.com',
      sessionToken: 'test-token',
      fetchFn: fakeFetch as unknown as typeof fetch,
    });

    const res = await client.heartbeat('mach-1');
    expect(attempts).toBe(2);
    expect(res.id).toBe('mach-1');
  });

  it('exhausts retries and throws if network error persists', async () => {
    let attempts = 0;
    const fakeFetch = vi.fn(async () => {
      attempts++;
      throw new TypeError('fetch failed');
    });

    const client = new CloudflareControlPlaneClient({
      baseUrl: 'https://api.example.com',
      sessionToken: 'test-token',
      fetchFn: fakeFetch as unknown as typeof fetch,
    });

    await expect(client.heartbeat('mach-1')).rejects.toThrow('fetch failed');
    expect(attempts).toBe(3);
  });
});
