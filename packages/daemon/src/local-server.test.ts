import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { WebSocket } from 'ws';
import { LocalTaskStore } from './local-task-store.js';
import { LocalServer } from './local-server.js';

describe('LocalServer', () => {
  let tempDir: string;
  let staticDir: string;
  let store: LocalTaskStore;
  let server: LocalServer;
  const token = 'test-token-1234567890123456789012';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-local-server-test-'));
    staticDir = path.join(tempDir, 'static');
    fs.mkdirSync(staticDir, { recursive: true });
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<html><body>Remote Hands UI</body></html>');
    fs.writeFileSync(path.join(staticDir, 'app.js'), 'console.log("hello");');

    store = new LocalTaskStore({ dbPath: path.join(tempDir, 'test.db') });
    server = new LocalServer({
      port: 0,
      pairingToken: token,
      store,
      staticDir,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/tasks`);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('Unauthorized');
  });

  it('rejects invalid pairing token with 401', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('allows authenticated requests and returns empty task list', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.tasks)).toBe(true);
    expect(json.tasks.length).toBe(0);
  });

  it('supports token in query parameter', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/tasks?token=${token}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.tasks)).toBe(true);
  });

  it('handles GET /api/status', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(typeof json.uptime).toBe('number');
  });

  it('handles GET /machines and GET /api/machines', async () => {
    const res1 = await fetch(`http://127.0.0.1:${server.port}/machines`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(Array.isArray(json1.machines)).toBe(true);
    expect(json1.machines.length).toBe(1);
    expect(typeof json1.machines[0]?.id).toBe('string');
    expect(json1.machines[0]?.id.length).toBeGreaterThan(0);

    const res2 = await fetch(`http://127.0.0.1:${server.port}/api/machines`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(Array.isArray(json2.machines)).toBe(true);
  });

  it('creates and retrieves tasks via POST and GET /api/tasks', async () => {
    const createRes = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        goal: 'Automate desktop workflow',
        workspacePath: os.homedir(),
      }),
    });
    expect(createRes.status).toBe(201);
    const createJson = await createRes.json();
    expect(createJson.task).toBeDefined();
    expect(createJson.task.id).toBeDefined();
    expect(createJson.task.goal).toBe('Automate desktop workflow');

    const getRes = await fetch(`http://127.0.0.1:${server.port}/api/tasks/${createJson.task.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    expect(getJson.task.id).toBe(createJson.task.id);

    const listRes = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listJson = await listRes.json();
    expect(listJson.tasks.length).toBe(1);
    expect(listJson.tasks[0].id).toBe(createJson.task.id);
  });

  it('returns 404 for unknown task', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/tasks/non-existent-id`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it('handles task events and cancellation', async () => {
    const task = await store.createTask({ goal: 'Events test', workspacePath: os.homedir() });
    await store.recordEvent(task.id, { type: 'text', text: 'Step 1 complete' });

    const eventsRes = await fetch(`http://127.0.0.1:${server.port}/api/tasks/${task.id}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(eventsRes.status).toBe(200);
    const eventsJson = await eventsRes.json();
    expect(eventsJson.events.length).toBe(1);

    const cancelRes = await fetch(`http://127.0.0.1:${server.port}/api/tasks/${task.id}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'User requested abort' }),
    });
    expect(cancelRes.status).toBe(200);
    const cancelJson = await cancelRes.json();
    expect(cancelJson.task.status).toBe('cancelled');
  });

  it('handles approvals listing and decision', async () => {
    const task = await store.createTask({ goal: 'Approval test', workspacePath: os.homedir() });
    const approval = await store.createApproval(task.id, {
      summary: 'Confirm file deletion',
      action: 'delete_file',
      risk: 'high',
    });

    const listRes = await fetch(`http://127.0.0.1:${server.port}/api/approvals`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    expect(listJson.approvals.length).toBe(1);
    expect(listJson.approvals[0].id).toBe(approval.id);

    const filterRes = await fetch(`http://127.0.0.1:${server.port}/api/approvals?taskId=${task.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const filterJson = await filterRes.json();
    expect(filterJson.approvals.length).toBe(1);

    const decideRes = await fetch(`http://127.0.0.1:${server.port}/api/approvals/${approval.id}/decision`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(decideRes.status).toBe(200);
    const decideJson = await decideRes.json();
    expect(decideJson.approval.status).toBe('approved');
  });

  it('serves static files safely and prevents path traversal', async () => {
    const rootRes = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(rootRes.status).toBe(200);
    const rootText = await rootRes.text();
    expect(rootText).toContain('Remote Hands UI');

    const assetRes = await fetch(`http://127.0.0.1:${server.port}/app.js`);
    expect(assetRes.status).toBe(200);
    const assetContent = await assetRes.text();
    expect(assetContent).toContain('console.log');

    const spaRes = await fetch(`http://127.0.0.1:${server.port}/dashboard/tasks`);
    expect(spaRes.status).toBe(200);
    const spaText = await spaRes.text();
    expect(spaText).toContain('Remote Hands UI');

    const missingAsset = await fetch(`http://127.0.0.1:${server.port}/missing.css`);
    expect(missingAsset.status).toBe(404);

    const traversalRes = await fetch(`http://127.0.0.1:${server.port}/..%2f..%2fetc/passwd`);
    expect(traversalRes.status).toBe(403);

    const rawStatus = await new Promise<number>((resolve) => {
      const req = http.get({
        host: '127.0.0.1',
        port: server.port,
        path: '/../../etc/passwd',
      }, (res) => {
        resolve(res.statusCode ?? 0);
      });
      req.on('error', () => resolve(0));
    });
    expect([400, 403, 404]).toContain(rawStatus);
  });

  it('handles CORS options preflight', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('rejects websocket connection without valid token', async () => {
    const task = await store.createTask({ goal: 'ws reject test', workspacePath: os.homedir() });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/tasks/${task.id}`);

    await new Promise<void>((resolve) => {
      ws.on('error', () => {
        resolve();
      });
      ws.on('close', (code) => {
        expect(code).not.toBe(1000);
        resolve();
      });
    });
  });

  it('accepts websocket connection, broadcasts messages and streams frames', async () => {
    const task = await store.createTask({ goal: 'ws test', workspacePath: os.homedir() });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/tasks/${task.id}?token=${token}`);

    const received: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    ws.on('message', (data) => {
      received.push(JSON.parse(data.toString()));
    });

    server.broadcast(task.id, { type: 'test.ping', message: 'hello' });
    server.broadcastFrame(task.id, { jpegBase64: 'fake-jpeg-data', capturedAt: '2026-09-22T00:00:00Z' });

    await new Promise<void>((resolve) => {
      const check = () => {
        if (received.length >= 2) {
          resolve();
        } else {
          setTimeout(check, 20);
        }
      };
      check();
    });

    expect(received.length).toBe(2);
    expect(received[0].type).toBe('test.ping');
    expect(received[1].type).toBe('task.frame');
    expect(received[1].jpeg_base64).toBe('fake-jpeg-data');

    ws.close();
  });
});
