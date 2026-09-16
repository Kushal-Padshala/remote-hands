import { describe, expect, it } from 'vitest';
import { TaskRoom } from './task-room.js';

describe('TaskRoom Durable Object relay', () => {
  it('relays events between phone and daemon and rejects invalid messages', async () => {
    const room = new TaskRoom({} as any, {} as any);

    const phoneMessages: any[] = [];
    const daemonMessages: any[] = [];

    const phoneSocket = {
      send(data: string) {
        phoneMessages.push(JSON.parse(data));
      },
      close() {},
    };

    const daemonSocket = {
      send(data: string) {
        daemonMessages.push(JSON.parse(data));
      },
      close() {},
    };

    room.handleConnection(phoneSocket as any, 'phone');
    room.handleConnection(daemonSocket as any, 'daemon');

    await room.handleMessage(
      phoneSocket as any,
      JSON.stringify({
        type: 'hello',
        role: 'phone',
        protocol_version: 1,
      }),
    );

    await room.handleMessage(
      daemonSocket as any,
      JSON.stringify({
        type: 'task.event',
        task_id: '11111111-1111-4111-8111-111111111111',
        event: {
          kind: 'agent_text',
          payload: { text: 'Starting browser automation' },
        },
      }),
    );

    expect(phoneMessages).toHaveLength(1);
    expect(phoneMessages[0].type).toBe('task.event');
    expect(phoneMessages[0].event.payload.text).toBe('Starting browser automation');

    await room.handleMessage(
      phoneSocket as any,
      JSON.stringify({
        type: 'invalid.message.type',
      }),
    );

    expect(phoneMessages).toHaveLength(2);
    expect(phoneMessages[1].type).toBe('error');
    expect(phoneMessages[1].message).toMatch(/Invalid realtime message/);
  });
});
