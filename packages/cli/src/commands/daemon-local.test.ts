import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { daemonCommand } from './daemon.js';

describe('daemonCommand local mode fallback', () => {
  it('starts local embedded server when daemon.json does not exist', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-daemon-test-'));
    const stdout = vi.fn();
    const code = await daemonCommand(['--once', '--local'], {
      configDir: tempDir,
      stdout,
      fs,
    });
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Local Server online'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('automatically falls back to local embedded server when daemon.json is missing without --local flag', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-daemon-test-'));
    const stdout = vi.fn();
    const code = await daemonCommand(['--once'], {
      configDir: tempDir,
      stdout,
      fs,
    });
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Local Server online'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses specified port when --port is provided', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-daemon-test-'));
    const stdout = vi.fn();
    const code = await daemonCommand(['--once', '--local', '--port=3456'], {
      configDir: tempDir,
      stdout,
      fs,
    });
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining(':3456/'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs local mode when --local is explicitly passed even if daemon.json exists', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-daemon-test-'));
    fs.writeFileSync(
      path.join(tempDir, 'daemon.json'),
      JSON.stringify({
        cloudflareApiUrl: 'https://example.com',
        sessionToken: 'token-123',
      }),
    );
    const stdout = vi.fn();
    const code = await daemonCommand(['--once', '--local'], {
      configDir: tempDir,
      stdout,
      fs,
    });
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Local Server online'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('defaults to local embedded server even if daemon.json exists when --cloud is not provided', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-daemon-test-'));
    fs.writeFileSync(
      path.join(tempDir, 'daemon.json'),
      JSON.stringify({
        cloudflareApiUrl: 'https://example.com',
        sessionToken: 'token-123',
      }),
    );
    const stdout = vi.fn();
    const code = await daemonCommand(['--once'], {
      configDir: tempDir,
      stdout,
      fs,
    });
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Local Server online'));
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Local Browser:'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
