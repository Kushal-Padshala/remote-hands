import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, type TestUser } from './helpers.js';

let alice: TestUser;
let mallory: TestUser;
let aliceMachineId: string;
let aliceTaskId: string;
let aliceApprovalId: string;

beforeAll(async () => {
  alice = await createUser();
  mallory = await createUser();

  const { data: machine, error: mErr } = await alice.client
    .from('machines')
    .insert({ user_id: alice.id, name: 'alice-air', hostname: 'alice-air.local' })
    .select()
    .single();
  if (mErr) throw mErr;
  aliceMachineId = machine.id;

  const { data: task, error: tErr } = await alice.client
    .from('tasks')
    .insert({ user_id: alice.id, machine_id: aliceMachineId, prompt: 'add a privacy policy page' })
    .select()
    .single();
  if (tErr) throw tErr;
  aliceTaskId = task.id;

  const { error: eErr } = await alice.client.from('events').insert({
    task_id: aliceTaskId,
    user_id: alice.id,
    seq: 0,
    kind: 'agent_text',
    payload: { text: 'starting' },
  });
  if (eErr) throw eErr;

  const { data: approval, error: aErr } = await alice.client
    .from('approvals')
    .insert({
      task_id: aliceTaskId,
      user_id: alice.id,
      action_kind: 'shell',
      summary: 'run rm -rf build/',
      risk: 'high',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    .select()
    .single();
  if (aErr) throw aErr;
  aliceApprovalId = approval.id;
}, 60_000);

describe('the owner', () => {
  it('sees their own machine, task and event', async () => {
    const machines = await alice.client.from('machines').select();
    const tasks = await alice.client.from('tasks').select();
    const events = await alice.client.from('events').select();
    expect(machines.data).toHaveLength(1);
    expect(tasks.data).toHaveLength(1);
    expect(events.data).toHaveLength(1);
  });
});

describe('a second user', () => {
  it('sees no machines', async () => {
    const { data } = await mallory.client.from('machines').select();
    expect(data).toEqual([]);
  });

  it('sees no tasks', async () => {
    const { data } = await mallory.client.from('tasks').select();
    expect(data).toEqual([]);
  });

  it('sees no events', async () => {
    const { data } = await mallory.client.from('events').select();
    expect(data).toEqual([]);
  });

  it('cannot read a task by its id', async () => {
    const { data } = await mallory.client.from('tasks').select().eq('id', aliceTaskId);
    expect(data).toEqual([]);
  });

  it('cannot queue a task onto someone else machine', async () => {
    const { error } = await mallory.client
      .from('tasks')
      .insert({ user_id: alice.id, machine_id: aliceMachineId, prompt: 'exfiltrate' });
    expect(error).not.toBeNull();
  });

  it('cannot forge a task owned by themselves on another machine', async () => {
    const { error } = await mallory.client
      .from('tasks')
      .insert({ user_id: mallory.id, machine_id: aliceMachineId, prompt: 'exfiltrate' });
    expect(error).not.toBeNull();
  });

  it('cannot cancel someone else task', async () => {
    const { data } = await mallory.client
      .from('tasks')
      .update({ status: 'cancelled' })
      .eq('id', aliceTaskId)
      .select();
    expect(data).toEqual([]);

    const { data: still } = await alice.client.from('tasks').select().eq('id', aliceTaskId).single();
    expect(still.status).toBe('queued');
  });

  it('cannot insert an event referencing someone else task', async () => {
    const { error } = await mallory.client.from('events').insert({
      task_id: aliceTaskId,
      user_id: mallory.id,
      seq: 1,
      kind: 'agent_text',
      payload: { text: 'forged' },
    });
    expect(error).not.toBeNull();
  });

  it('cannot insert an approval referencing someone else task', async () => {
    const { error } = await mallory.client.from('approvals').insert({
      task_id: aliceTaskId,
      user_id: mallory.id,
      action_kind: 'shell',
      summary: 'forged approval',
      risk: 'high',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    expect(error).not.toBeNull();
  });
});

describe('the append-only event log', () => {
  it('refuses an update even from the owner', async () => {
    const { data } = await alice.client
      .from('events')
      .update({ payload: { text: 'rewritten' } })
      .eq('task_id', aliceTaskId)
      .select();
    expect(data).toEqual([]);
  });
});

describe('approvals', () => {
  it('the owner sees their own approval', async () => {
    const { data } = await alice.client.from('approvals').select();
    expect(data).toHaveLength(1);
  });

  it('a second user sees no approvals', async () => {
    const { data } = await mallory.client.from('approvals').select();
    expect(data).toEqual([]);
  });

  it('a second user cannot read one by id', async () => {
    const { data } = await mallory.client.from('approvals').select().eq('id', aliceApprovalId);
    expect(data).toEqual([]);
  });

  it('a second user cannot update someone else approval', async () => {
    const { data } = await mallory.client
      .from('approvals')
      .update({ decision: 'approved', decided_at: new Date().toISOString() })
      .eq('id', aliceApprovalId)
      .select();
    expect(data).toEqual([]);

    const { data: still } = await alice.client
      .from('approvals')
      .select()
      .eq('id', aliceApprovalId)
      .single();
    expect(still.decision).toBe('pending');
  });
});
