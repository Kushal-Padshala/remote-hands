import { describe, expect, it } from 'vitest';
import {
  parseRealtimeMessage,
  safeParseRealtimeMessage,
  REALTIME_PROTOCOL_VERSION,
} from './realtime.js';

describe('realtime transport contract', () => {
  it('parses valid hello messages', () => {
    const msg = {
      type: 'hello',
      role: 'daemon',
      protocol_version: REALTIME_PROTOCOL_VERSION,
    };
    expect(parseRealtimeMessage(msg)).toEqual(msg);
  });

  it('parses valid task event messages', () => {
    const msg = {
      type: 'task.event',
      task_id: '11111111-1111-4111-8111-111111111111',
      event: {
        kind: 'agent_text',
        payload: { text: 'Starting task' },
      },
    };
    expect(parseRealtimeMessage(msg)).toEqual(msg);
  });

  it('parses valid task frame messages', () => {
    const msg = {
      type: 'task.frame',
      task_id: '11111111-1111-4111-8111-111111111111',
      jpeg_base64: 'aW1hZ2VkYXRh',
      captured_at: '2026-09-16T12:00:00.000Z',
    };
    expect(parseRealtimeMessage(msg)).toEqual(msg);
  });

  it('parses valid approval requested and decided messages', () => {
    const req = {
      type: 'approval.requested',
      task_id: '11111111-1111-4111-8111-111111111111',
      approval_id: '22222222-2222-4222-8222-222222222222',
    };
    expect(parseRealtimeMessage(req)).toEqual(req);

    const dec = {
      type: 'approval.decided',
      approval_id: '22222222-2222-4222-8222-222222222222',
      decision: 'approved',
    };
    expect(parseRealtimeMessage(dec)).toEqual(dec);
  });

  it('parses valid heartbeat and error messages', () => {
    const hb = {
      type: 'heartbeat',
      machine_id: '33333333-3333-4333-8333-333333333333',
      sent_at: '2026-09-16T12:00:00.000Z',
    };
    expect(parseRealtimeMessage(hb)).toEqual(hb);

    const err = {
      type: 'error',
      message: 'Connection closed unexpectedly',
    };
    expect(parseRealtimeMessage(err)).toEqual(err);
  });

  it('rejects invalid messages via safeParseRealtimeMessage', () => {
    expect(safeParseRealtimeMessage({ type: 'task.frame', task_id: 'bad' }).ok).toBe(false);
    expect(safeParseRealtimeMessage({ type: 'unknown_type' }).ok).toBe(false);
    expect(safeParseRealtimeMessage(null).ok).toBe(false);
  });
});
