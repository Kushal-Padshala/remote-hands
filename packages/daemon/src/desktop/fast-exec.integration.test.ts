import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExecFunction } from './macos-driver.js';
import { hoistSwiftParams, createFastExec } from './fast-exec.js';
import { performAxAction, getAvailableAxActions, setAxElementValue } from './ax-actions.js';
import { crawlAppMenu, searchAndTriggerMenu } from './menu-crawler.js';
import { AxWalker } from './ax-walker.js';

const hasSwiftc = process.platform === 'darwin' && spawnSync('swiftc', ['--version']).status === 0;

describe.skipIf(!hasSwiftc)('real swift script templates', () => {
  const scripts = new Map<string, string>();
  const capture: ExecFunction = (command, args) => {
    if (command === 'swift' && args[0] === '-e' && args[1]) {
      scripts.set(String(scripts.size), args[1]);
    }
    return { stdout: '[]', stderr: '', status: 0 };
  };

  it('every hoisted template type-checks and keeps its parameters', async () => {
    const target = { index: 3, bounds: [1, 2, 3, 4] as [number, number, number, number], role: 'AXButton', label: 'Save "As"' };
    await performAxAction('Finder', target, 'AXPress', capture);
    await getAvailableAxActions('Finder', target, capture);
    await setAxElementValue('Finder', target, 'va"lue', capture);
    await crawlAppMenu('Finder', capture);
    await searchAndTriggerMenu('Finder', 'Save "As"', capture);
    await new AxWalker({ exec: capture }).walkNativeSwift('Finder', capture, { allowOcr: false, windowTitle: 'Win "1"' });
    expect(scripts.size).toBeGreaterThanOrEqual(6);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-int-'));
    for (const [id, script] of scripts) {
      const { template, hoisted } = hoistSwiftParams(script);
      expect(hoisted, `script ${id} should hoist`).toBe(true);
      const file = path.join(dir, `${id}.swift`);
      fs.writeFileSync(file, template);
      const res = spawnSync('swiftc', ['-typecheck', file], { encoding: 'utf-8' });
      expect(res.status, `script ${id}:\n${res.stderr}`).toBe(0);
    }
  }, 120_000);
});

describe.skipIf(!hasSwiftc)('fastExec with the real swiftc', () => {
  const swiftLiteral = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  it('round-trips quoted, backslashed and unicode parameters through one compiled binary', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-rt-'));
    const exec = createFastExec({ cacheDir });
    const values = ['He said "hi" \\ back\\slash \\"', 'ünïcødé 🚀 日本語', "it's \\(x) $HOME %s", ''];
    for (const value of values) {
      const script = `import Foundation\nlet query = "${swiftLiteral(value)}"\nlet count = 3\nprint(query)\nprint(count)\n`;
      const res = exec('swift', ['-e', script]);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toBe(`${value}\n3\n`);
    }
    const entries = fs.readdirSync(cacheDir);
    expect(entries).toHaveLength(1);
    expect(fs.existsSync(path.join(cacheDir, entries[0]!, 'bin'))).toBe(true);
  }, 120_000);

  it('passes trailing script arguments to the compiled binary', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-args-'));
    const exec = createFastExec({ cacheDir });
    const script = 'import Foundation\nlet tag = "x"\nprint(CommandLine.arguments.dropFirst().joined(separator: "|"))\n';
    const res = exec('swift', ['-e', script, '/tmp/out file.jpg', '1280']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.trim()).toBe('/tmp/out file.jpg|1280');
  }, 120_000);
});
