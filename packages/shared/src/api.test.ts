import { describe, expect, it } from 'vitest';
import {
  createTaskRequestSchema,
  startPairingRequestSchema,
  claimPairingRequestSchema,
  decideApprovalRequestSchema,
  createApprovalRequestSchema,
  setupOwnerRequestSchema,
} from './api.js';

describe('api request and response contracts', () => {
  it('validates setup owner request', () => {
    const valid = {
      owner_secret: 'secret1234567890',
    };
    expect(setupOwnerRequestSchema.parse(valid)).toEqual(valid);
    expect(() => setupOwnerRequestSchema.parse({ owner_secret: '' })).toThrow();
  });

  it('validates start pairing request', () => {
    const valid = {
      machine_name: 'work-laptop',
    };
    expect(startPairingRequestSchema.parse(valid)).toEqual(valid);
    expect(() => startPairingRequestSchema.parse({ machine_name: '' })).toThrow();
  });

  it('validates claim pairing request', () => {
    const valid = {
      pairing_code: '123456',
      hostname: 'macbook.local',
      daemon_version: '0.1.0',
      agy_version: '0.2.0',
    };
    expect(claimPairingRequestSchema.parse(valid)).toMatchObject(valid);
    expect(() => claimPairingRequestSchema.parse({ pairing_code: '' })).toThrow();
  });

  it('validates task creation request', () => {
    const valid = {
      machine_id: '22222222-2222-4222-8222-222222222222',
      prompt: 'Add privacy policy',
      kind: 'browser',
    };
    const parsed = createTaskRequestSchema.parse(valid);
    expect(parsed.kind).toBe('browser');
    expect(parsed.mode).toBe('default');
    expect(() => createTaskRequestSchema.parse({ prompt: '' })).toThrow();
  });


  it('validates approval creation and decision requests', () => {
    const approvalReq = {
      task_id: '11111111-1111-4111-8111-111111111111',
      action_kind: 'publish',
      summary: 'Publish policy page',
      risk: 'high',
      tool_payload: { url: 'https://example.com/privacy' },
    };
    expect(createApprovalRequestSchema.parse(approvalReq)).toMatchObject({ risk: 'high' });

    const decisionReq = {
      decision: 'approved',
    };
    expect(decideApprovalRequestSchema.parse(decisionReq)).toEqual(decisionReq);
    expect(() => decideApprovalRequestSchema.parse({ decision: 'unknown' })).toThrow();
  });
});
