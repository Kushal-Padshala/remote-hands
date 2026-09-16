import { describe, expect, it } from 'vitest';
import { main } from './index.js';

describe('CLI command dispatcher', () => {
  it('dispatches setup command', async () => {
    const logs: string[] = [];
    const code = await main(['setup'], { stdout: (msg) => logs.push(msg) });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('setup'))).toBe(true);
  });

  it('dispatches deploy command', async () => {
    const logs: string[] = [];
    const code = await main(['deploy'], { stdout: (msg) => logs.push(msg) });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('Deploying'))).toBe(true);
  });

  it('dispatches daemon command', async () => {
    const logs: string[] = [];
    const code = await main(['daemon'], { stdout: (msg) => logs.push(msg) });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('daemon'))).toBe(true);
  });

  it('dispatches doctor command', async () => {
    const logs: string[] = [];
    const code = await main(['doctor'], { stdout: (msg) => logs.push(msg) });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('health checks'))).toBe(true);
  });

  it('prints help on --help or no command', async () => {
    const logs: string[] = [];
    const code = await main(['--help'], { stdout: (msg) => logs.push(msg) });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('Usage: remote-hands'))).toBe(true);

    const emptyLogs: string[] = [];
    const codeEmpty = await main([], { stdout: (msg) => emptyLogs.push(msg) });
    expect(codeEmpty).toBe(0);
    expect(emptyLogs.some((l) => l.includes('Usage: remote-hands'))).toBe(true);
  });

  it('returns error code 1 on unknown command', async () => {
    const errors: string[] = [];
    const code = await main(['foobar'], { stderr: (msg) => errors.push(msg) });
    expect(code).toBe(1);
    expect(errors.some((e) => e.includes('Unknown command: foobar'))).toBe(true);
  });
});
