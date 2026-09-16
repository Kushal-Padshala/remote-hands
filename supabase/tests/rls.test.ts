import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, type TestUser } from './helpers.js';

let alice: TestUser;
let mallory: TestUser;
let aliceMachineId: string;
let aliceTaskId: string;
let aliceApprovalId: string;
let malloryMachineId: string;

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

  describe('parent_task_id', () => {
    beforeAll(async () => {
      const { data: malloryMachine, error: mmErr } = await mallory.client
        .from('machines')
        .insert({ user_id: mallory.id, name: 'mallory-air', hostname: 'mallory-air.local' })
        .select()
        .single();
      if (mmErr) throw mmErr;
      malloryMachineId = malloryMachine.id;
    }, 60_000);

    it('cannot create a task whose parent_task_id points at someone else task', async () => {
      const { error } = await mallory.client.from('tasks').insert({
        user_id: mallory.id,
        machine_id: malloryMachineId,
        parent_task_id: aliceTaskId,
        prompt: 'forged parent',
      });
      expect(error).not.toBeNull();
    });

    it('cannot re-parent her own task onto someone else task', async () => {
      const { data: own, error: ownErr } = await mallory.client
        .from('tasks')
        .insert({ user_id: mallory.id, machine_id: malloryMachineId, prompt: 'mallory own task' })
        .select()
        .single();
      if (ownErr) throw ownErr;

      // Unlike an update that targets someone else's row (rejected by `using`,
      // which just filters it out of the update with no error), this row is
      // mallory's own: `using` lets it through and `with check` rejects the
      // resulting state outright, so PostgREST reports a permission error
      // rather than silently affecting zero rows.
      const { error } = await mallory.client
        .from('tasks')
        .update({ parent_task_id: aliceTaskId })
        .eq('id', own.id)
        .select();
      expect(error).not.toBeNull();

      const { data: still } = await mallory.client
        .from('tasks')
        .select()
        .eq('id', own.id)
        .single();
      expect(still.parent_task_id).toBeNull();
    });

    it('can set parent_task_id to her own task', async () => {
      const { data: parent, error: parentErr } = await mallory.client
        .from('tasks')
        .insert({ user_id: mallory.id, machine_id: malloryMachineId, prompt: 'mallory parent task' })
        .select()
        .single();
      if (parentErr) throw parentErr;

      const { data: child, error: childErr } = await mallory.client
        .from('tasks')
        .insert({
          user_id: mallory.id,
          machine_id: malloryMachineId,
          parent_task_id: parent.id,
          prompt: 'mallory child task',
        })
        .select()
        .single();
      expect(childErr).toBeNull();
      expect(child?.parent_task_id).toBe(parent.id);
    });
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
