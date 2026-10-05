import { spawn } from 'node:child_process';
import type { CommandResult, CommandRunner } from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/** The real runner: `spawn(file, args)` with no shell, a timeout, and failures reported as results. */
export const systemCommandRunner: CommandRunner = {
  run(file, args, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<CommandResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ code: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
        return;
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ code: -1, stdout, stderr: `${stderr}${stderr ? '\n' : ''}timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (err) => finish({ code: -1, stdout, stderr: err.message }));
      child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }));
    });
  },
};
