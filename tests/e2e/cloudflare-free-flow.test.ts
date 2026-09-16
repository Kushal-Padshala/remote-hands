import { describe, expect, it } from 'vitest';
import { createTestCloudflareHarness } from './helpers/cloudflare-harness.js';
import { FakeDaemon } from './helpers/fake-daemon.js';
import { CloudflareControlPlaneClient } from '../../packages/daemon/src/cloudflare-client.js';
import { hashSessionToken, createSessionToken } from '../../apps/cloudflare/src/auth/session.js';

describe('Free Cloudflare End-to-End Task Flow', () => {
  it('executes full task lifecycle from phone creation through daemon approval to completion', async () => {
    const { db, dispatchFetch } = createTestCloudflareHarness();

    const ownerSecret = 'super-secret-owner-passphrase-12345';
    const setupRes = await dispatchFetch('/setup/owner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner_secret: ownerSecret }),
    });
    expect(setupRes.status).toBe(201);
    const { owner_id: ownerId } = (await setupRes.json()) as any;

    const phoneToken = createSessionToken();
    const phoneTokenHash = await hashSessionToken(phoneToken);
    await db
      .prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(
        'sess-phone-1',
        ownerId,
        null,
        'phone',
        phoneTokenHash,
        new Date(Date.now() + 86400000).toISOString(),
        new Date().toISOString(),
      )
      .run();

    const pairingStartRes = await dispatchFetch('/pairing/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${phoneToken}`,
      },
      body: JSON.stringify({ machine_name: 'Work MacBook Pro' }),
    });
    expect(pairingStartRes.status).toBe(201);
    const { pairing_code: pairingCode } = (await pairingStartRes.json()) as any;

    const pairingClaimRes = await dispatchFetch('/pairing/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairing_code: pairingCode,
        hostname: 'macbook.local',
        daemon_version: '0.1.0',
        agy_version: '0.2.0',
      }),
    });
    expect(pairingClaimRes.status).toBe(201);
    const { machine_id: machineId, session_token: daemonToken } =
      (await pairingClaimRes.json()) as any;

    const daemonClient = new CloudflareControlPlaneClient({
      baseUrl: 'https://example.com',
      sessionToken: daemonToken,
      fetchFn: dispatchFetch as unknown as typeof fetch,
    });

    const daemon = new FakeDaemon({
      client: daemonClient,
      machineId,
    });

    const createTaskRes = await dispatchFetch('/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${phoneToken}`,
      },
      body: JSON.stringify({
        machine_id: machineId,
        prompt: 'Add a privacy policy page to my WordPress site',
        kind: 'browser',
        mode: 'default',
      }),
    });
    expect(createTaskRes.status).toBe(201);
    const { task: createdTask } = (await createTaskRes.json()) as any;
    expect(createdTask.status).toBe('queued');

    const daemonResult = await daemon.runOnce();
    expect(daemonResult.claimed).toBe(true);
    expect(daemonResult.task?.id).toBe(createdTask.id);
    expect(daemonResult.approval).toBeDefined();
    expect(daemonResult.approval?.decision).toBe('pending');
    expect(daemonResult.approval?.action_kind).toBe('publish');

    const approveRes = await dispatchFetch(
      `/approvals/${daemonResult.approval!.id}/decision`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${phoneToken}`,
        },
        body: JSON.stringify({ decision: 'approved' }),
      },
    );
    expect(approveRes.status).toBe(200);
    const { approval: decidedApproval } = (await approveRes.json()) as any;
    expect(decidedApproval.decision).toBe('approved');

    const completedTask = await daemon.finishApprovedTask(createdTask.id);
    expect(completedTask.status).toBe('done');
    expect(completedTask.result_summary).toBe('Added privacy policy page');

    const phoneTaskRes = await dispatchFetch(`/tasks/${createdTask.id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${phoneToken}` },
    });
    expect(phoneTaskRes.status).toBe(200);
    const { task: finalTask } = (await phoneTaskRes.json()) as any;
    expect(finalTask.status).toBe('done');
    expect(finalTask.result_summary).toBe('Added privacy policy page');

    const phoneEventsRes = await dispatchFetch(`/tasks/${createdTask.id}/events`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${phoneToken}` },
    });
    expect(phoneEventsRes.status).toBe(200);
    const { events } = (await phoneEventsRes.json()) as any;

    const eventKinds = events.map((e: any) => e.kind);
    expect(eventKinds).toContain('status');
    expect(eventKinds).toContain('browser_action');
    expect(eventKinds).toContain('result');

    const browserEvent = events.find((e: any) => e.kind === 'browser_action');
    expect(browserEvent.payload.label).toBe('Navigated to WordPress admin');
  });
});
