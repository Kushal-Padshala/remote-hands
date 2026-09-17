import { describe, expect, it, vi } from 'vitest';
import type { RealtimeMessage } from '@remote-hands/shared';
import { RealtimeClient } from './realtime-client.js';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  public url: string;
  public readyState = 0;
  public sent: string[] = [];
  public listeners: Record<string, ((event: any) => void)[]> = {};

  constructor(url: string, autoOpen = true) {
    this.url = url;
    MockWebSocket.instances.push(this);
    if (autoOpen) {
      setTimeout(() => {
        this.readyState = 1;
        this.trigger('open', {});
      }, 5);
    }
  }

  addEventListener(event: string, fn: (event: any) => void): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  removeEventListener(event: string, fn: (event: any) => void): void {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter((l) => l !== fn);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.trigger('close', { code: 1000, reason: 'normal' });
  }

  trigger(event: string, data: any): void {
    const handlers = this.listeners[event] ?? [];
    for (const handler of handlers) {
      handler(data);
    }
  }
}

describe('RealtimeClient', () => {
  it('connects to machine websocket with token and sends hello', async () => {
    MockWebSocket.instances = [];

    const client = new RealtimeClient({
      baseUrl: 'https://api.example.com',
      sessionToken: 'test-token',
      reconnect: false,
      webSocketFactory: (url) => new MockWebSocket(url) as any,
    });

    await client.connectMachine('mach-123');

    const ws = MockWebSocket.instances[0]!;
    expect(ws.url).toBe('wss://api.example.com/ws/machines/mach-123?token=test-token');

    const helloMsg = JSON.parse(ws.sent[0]!);
    expect(helloMsg).toEqual({ type: 'hello', role: 'daemon', protocol_version: 1 });

    client.close();
  });

  it('serializes and sends outgoing realtime message', async () => {
    MockWebSocket.instances = [];

    const client = new RealtimeClient({
      baseUrl: 'http://localhost:8787',
      sessionToken: 'test-token',
      reconnect: false,
      webSocketFactory: (url) => new MockWebSocket(url) as any,
    });

    await client.connectTask('task-999');

    const ws = MockWebSocket.instances[0]!;
    expect(ws.url).toBe('ws://localhost:8787/ws/tasks/task-999?token=test-token');

    const msg: RealtimeMessage = {
      type: 'task.event',
      task_id: '11111111-1111-4111-8111-111111111111',
      event: {
        kind: 'agent_text',
        payload: { text: 'Running task...' },
      },
    };

    client.send(msg);

    expect(ws.sent.length).toBe(2);
    const sent = JSON.parse(ws.sent[1]!);
    expect(sent.type).toBe('task.event');
    expect(sent.task_id).toBe('11111111-1111-4111-8111-111111111111');

    client.close();
  });

  it('parses incoming message with safeParseRealtimeMessage and dispatches to handler', async () => {
    MockWebSocket.instances = [];

    const client = new RealtimeClient({
      baseUrl: 'https://api.example.com',
      sessionToken: 'test-token',
      reconnect: false,
      webSocketFactory: (url) => new MockWebSocket(url) as any,
    });

    await client.connectTask('task-100');
    const ws = MockWebSocket.instances[0]!;

    const received: RealtimeMessage[] = [];
    const unsubscribe = client.onMessage((msg) => {
      received.push(msg);
    });

    ws.trigger('message', {
      data: JSON.stringify({
        type: 'approval.decided',
        approval_id: '44444444-4444-4444-8444-444444444444',
        decision: 'approved',
      }),
    });

    expect(received.length).toBe(1);
    expect(received[0]!.type).toBe('approval.decided');

    unsubscribe();

    ws.trigger('message', {
      data: JSON.stringify({
        type: 'heartbeat',
        machine_id: '22222222-2222-4222-8222-222222222222',
        sent_at: new Date().toISOString(),
      }),
    });

    expect(received.length).toBe(1);
    client.close();
  });

  it('schedules reconnect when socket error occurs', async () => {
    MockWebSocket.instances = [];

    class FailingWebSocket extends MockWebSocket {
      constructor(url: string) {
        super(url, false);
        setTimeout(() => {
          this.readyState = 3;
          this.trigger('error', new Error('Connection failed'));
        }, 5);
      }
    }

    const client = new RealtimeClient({
      baseUrl: 'https://api.example.com',
      sessionToken: 'test-token',
      reconnect: true,
      baseBackoffMs: 10,
      webSocketFactory: (url) => new FailingWebSocket(url) as any,
    });

    await expect(client.connectMachine('mach-err')).rejects.toThrow();
    expect(MockWebSocket.instances.length).toBe(1);

    await new Promise((r) => setTimeout(r, 40));
    expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    client.close();
  });
});
