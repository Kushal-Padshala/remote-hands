import { describe, expect, it } from 'vitest';
import {
  checkBrowserHarness,
  installBrowserHarness,
  registerBrowserHarnessSkill,
  ensureBrowserHarness,
} from './browser-harness.js';
import type { CommandRunner } from '../cloudflare/wrangler.js';
import type { FileSystemAdapter } from '../cloudflare/project.js';

describe('Browser Harness Automation', () => {
  it('checks if browser-harness is installed', async () => {
    const fakeRunner: CommandRunner = async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'browser-harness') {
        return { exitCode: 0, stdout: '/usr/local/bin/browser-harness', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    };

    const installed = await checkBrowserHarness(fakeRunner);
    expect(installed).toBe(true);
  });

  it('attempts to install via uv when uv is present', async () => {
    const executed: string[] = [];
    const fakeRunner: CommandRunner = async (cmd, args) => {
      executed.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'which' && args[0] === 'uv') {
        return { exitCode: 0, stdout: '/opt/homebrew/bin/uv', stderr: '' };
      }
      if (cmd === 'uv' && args[0] === 'tool') {
        return { exitCode: 0, stdout: 'Installed browser-harness', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    };

    const res = await installBrowserHarness(fakeRunner);
    expect(res.success).toBe(true);
    expect(res.method).toBe('uv');
    expect(executed).toContain('uv tool install --python 3.12 browser-harness');
  });

  it('registers browser-harness skill in workspace and global directories', async () => {
    const writtenFiles: Record<string, string> = {};
    const mockFs: FileSystemAdapter = {
      readFile: async () => '',
      writeFile: async (p, content) => {
        writtenFiles[p] = content;
      },
      exists: async () => false,
    };

    const fakeRunner: CommandRunner = async (cmd, args) => {
      if (cmd === 'browser-harness' && args[0] === 'skill') {
        return { exitCode: 0, stdout: '---\nname: browser-harness\n---\n# skill', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    };

    const success = await registerBrowserHarnessSkill(fakeRunner, '/test/project', mockFs);
    expect(success).toBe(true);
    expect(Object.keys(writtenFiles).some((p) => p.includes('.agents/skills/browser-harness/SKILL.md'))).toBe(true);
  });

  it('ensures browser-harness is installed and registered', async () => {
    const outputLines: string[] = [];
    const writtenFiles: Record<string, string> = {};
    const mockFs: FileSystemAdapter = {
      readFile: async () => '',
      writeFile: async (p, content) => {
        writtenFiles[p] = content;
      },
      exists: async () => false,
    };

    let installed = false;
    const fakeRunner: CommandRunner = async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'browser-harness') {
        return installed
          ? { exitCode: 0, stdout: '/bin/browser-harness', stderr: '' }
          : { exitCode: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'which' && args[0] === 'uv') {
        return { exitCode: 0, stdout: '/bin/uv', stderr: '' };
      }
      if (cmd === 'uv') {
        installed = true;
        return { exitCode: 0, stdout: 'Installed', stderr: '' };
      }
      if (cmd === 'browser-harness' && args[0] === 'skill') {
        return { exitCode: 0, stdout: '---\nname: browser-harness\n---', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    };

    const ok = await ensureBrowserHarness(
      fakeRunner,
      '/test/project',
      (m) => outputLines.push(m),
      () => {},
      mockFs,
    );

    expect(ok).toBe(true);
    expect(outputLines.some((l) => l.includes('Installing via uv/pip'))).toBe(true);
  });
});
