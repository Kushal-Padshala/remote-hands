import { describe, expect, it } from 'vitest';
import { systemCommandRunner } from './runner.js';

describe('systemCommandRunner', () => {
  it('runs a program with an argument array and returns its output without a shell', async () => {
    const r = await systemCommandRunner.run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(echo hacked); `id`']);
    expect(r).toEqual({ code: 0, stdout: '$(echo hacked); `id`', stderr: '' });
  });

  it('reports a failing exit code and stderr', async () => {
    const r = await systemCommandRunner.run(process.execPath, ['-e', 'console.error("nope"); process.exit(3)']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('nope');
  });

  it('kills a program that runs past its timeout', async () => {
    const r = await systemCommandRunner.run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 100 });
    expect(r.code).toBe(-1);
    expect(r.stderr).toContain('timed out');
  });

  it('reports a missing program as a failure instead of throwing', async () => {
    const r = await systemCommandRunner.run('/definitely/not/here', []);
    expect(r.code).toBe(-1);
    expect(r.stderr).toMatch(/ENOENT|not/i);
  });
});
