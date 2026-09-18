import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseApproveArgs, approveCommand } from './approve.js';

describe('parseApproveArgs', () => {
  const originalEnv = process.env.REMOTE_HANDS_TASK_ID;

  beforeEach(() => {
    delete process.env.REMOTE_HANDS_TASK_ID;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.REMOTE_HANDS_TASK_ID = originalEnv;
    } else {
      delete process.env.REMOTE_HANDS_TASK_ID;
    }
  });

  it('parses summary from positional argument', () => {
    const res = parseApproveArgs(['Deploy to production']);
    expect(res.summary).toBe('Deploy to production');
    expect(res.action).toBe('other');
    expect(res.risk).toBe('medium');
    expect(res.timeoutSeconds).toBe(60);
  });

  it('parses flags with equals and spaces', () => {
    const res = parseApproveArgs([
      'Delete database',
      '--action=delete',
      '--risk',
      'critical',
      '--task=task-999',
      '--timeout',
      '120',
    ]);
    expect(res.summary).toBe('Delete database');
    expect(res.action).toBe('delete');
    expect(res.risk).toBe('critical');
    expect(res.taskId).toBe('task-999');
    expect(res.timeoutSeconds).toBe(120);
  });

  it('falls back to REMOTE_HANDS_TASK_ID environment variable', () => {
    process.env.REMOTE_HANDS_TASK_ID = 'env-task-1';
    const res = parseApproveArgs(['Post tweet']);
    expect(res.taskId).toBe('env-task-1');
  });
});

describe('approveCommand', () => {
  let tempDir: string;
  let stdoutLogs: string[] = [];
  let stderrLogs: string[] = [];

  beforeEach(() => {
    stdoutLogs = [];
    stderrLogs = [];
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-approve-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const getCtx = (client?: any) => ({
    stdout: (m: string) => stdoutLogs.push(m),
    stderr: (m: string) => stderrLogs.push(m),
    configDir: tempDir,
    client,
  });

  it('errors when summary argument is missing', async () => {
    const code = await approveCommand([], getCtx());
    expect(code).toBe(1);
    expect(stderrLogs.join('\n')).toContain('Usage: rh approve');
  });

  it('errors when task id cannot be found', async () => {
    delete process.env.REMOTE_HANDS_TASK_ID;
    const code = await approveCommand(['Publish post'], getCtx());
    expect(code).toBe(1);
    expect(stderrLogs.join('\n')).toContain('Error: No task ID provided');
  });

  it('errors when daemon.json is missing', async () => {
    const code = await approveCommand(['Publish post', '--task=t1'], getCtx());
    expect(code).toBe(1);
    expect(stderrLogs.join('\n')).toContain('Daemon configuration not found');
  });

  it('creates approval and succeeds when user approves', async () => {
    const configFile = path.join(tempDir, 'daemon.json');
    fs.writeFileSync(configFile, JSON.stringify({
      cloudflareApiUrl: 'https://example.workers.dev',
      sessionToken: 'test-token',
    }));

    const mockClient = {
      createApproval: vi.fn().mockResolvedValue({ id: 'app-1', decision: 'pending' }),
      getApproval: vi.fn().mockResolvedValue({ id: 'app-1', decision: 'approved' }),
    };

    const code = await approveCommand(['Publish post', '--task=t1', '--timeout=5'], getCtx(mockClient));
    expect(code).toBe(0);
    expect(mockClient.createApproval).toHaveBeenCalledWith({
      task_id: 't1',
      action_kind: 'other',
      summary: 'Publish post',
      risk: 'medium',
      timeout_ms: 5000,
    });
    expect(stdoutLogs.join('\n')).toContain('Approval granted.');
  });

  it('returns code 1 when user rejects approval', async () => {
    const configFile = path.join(tempDir, 'daemon.json');
    fs.writeFileSync(configFile, JSON.stringify({
      cloudflareApiUrl: 'https://example.workers.dev',
      sessionToken: 'test-token',
    }));

    const mockClient = {
      createApproval: vi.fn().mockResolvedValue({ id: 'app-2', decision: 'pending' }),
      getApproval: vi.fn().mockResolvedValue({ id: 'app-2', decision: 'rejected' }),
    };

    const code = await approveCommand(['Delete repo', '--task=t2', '--timeout=5'], getCtx(mockClient));
    expect(code).toBe(1);
    expect(stderrLogs.join('\n')).toContain('Approval rejected by user.');
  });

  it('handles creation error gracefully', async () => {
    const configFile = path.join(tempDir, 'daemon.json');
    fs.writeFileSync(configFile, JSON.stringify({
      cloudflareApiUrl: 'https://example.workers.dev',
      sessionToken: 'test-token',
    }));

    const mockClient = {
      createApproval: vi.fn().mockRejectedValue(new Error('Network error')),
    };

    const code = await approveCommand(['Deploy', '--task=t3'], getCtx(mockClient));
    expect(code).toBe(1);
    expect(stderrLogs.join('\n')).toContain('Failed to create approval request: Network error');
  });
});
