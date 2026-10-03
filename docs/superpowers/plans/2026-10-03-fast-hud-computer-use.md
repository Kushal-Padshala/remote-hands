# Fast HUD Computer Use Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the latency of HUD desktop and browser tasks from minutes to seconds while keeping `agy` as the only model provider (no API key).

**Architecture:** (1) Cache compiled Swift binaries so AX calls stop paying `swift -e` compile cost. (2) Host the drivers in a long-lived stdio MCP server (`rh mcp serve`) registered with `agy`, where every action returns compact post-action state. (3) Keep one warm `agy` process per HUD using `--input-format stream-json`, with a slim system prompt.

**Tech Stack:** TypeScript (ESM, strict), Node 22, vitest 5, zod 4, `@modelcontextprotocol/sdk`, macOS Swift (`swiftc`), `agy` CLI.

**Spec:** `docs/superpowers/specs/2026-10-03-fast-hud-computer-use-design.md`

## Global Constraints

- Node `>=22.0.0`; TypeScript strict; ESM with `.js` import suffixes (match existing files).
- No external model API key. All LLM calls go through the `agy` binary.
- Zero-screenshot and zero-physical-mouse policy stays: AX actions first; `clickAt` only as a labelled last-resort fallback.
- Existing tests that inject their own `exec` (`ax-walker.test.ts`, `ax-actions.test.ts`, `desktop-act.test.ts`, `menu-crawler.test.ts`) must keep passing unchanged.
- Test command per file: `npx vitest run <path>`. Never run the whole suite more than once, at the end.
- MCP stdout is the protocol channel: nothing but the SDK may write to stdout in `rh mcp serve`.
- Do not edit `~/.gemini/antigravity-cli/settings.json` by hand; `rh permissions fix` already sets `defaultAction: allow`.
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`

## Review Focus

- App or label text containing quotes, backslashes or non-ASCII (for example `Save "As"…`) must reach the compiled Swift binary unchanged (Task 2).
- Two `rh` processes compiling the same script at once must not corrupt the cache (Task 2).
- `swiftc` missing, or compile failing, must fall back to `swift -e` silently (Task 2).
- Clicking an index with no cached snapshot, or a stale index after the UI changed, must return a clear error telling the model to snapshot again, not click the wrong thing (Task 3).
- A tool error inside `computer_batch` must stop the batch and report which step failed (Task 4).
- User cancels from the HUD mid-turn: the warm `agy` process is killed and the next task still works (Task 5).
- New HUD hotkey session after an unrelated earlier task: context from the earlier task must not leak into the new one (Task 5).
- `agy` process dies between tasks: the next task transparently respawns (Task 5).

---

### Task 1: Baseline benchmark script

**Files:**
- Create: `scripts/bench-actions.mjs`

**Interfaces:**
- Consumes: `rh` and `agy` on `PATH`.
- Produces: prints one line per case, `name  median_ms  runs`. Used by Task 6 for the after-numbers.

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
// Usage: node scripts/bench-actions.mjs [runs]
import { spawnSync } from 'node:child_process';

const runs = Number(process.argv[2] ?? 5);

function timeMs(cmd, args) {
  const start = process.hrtime.bigint();
  const res = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 120_000 });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms, ok: res.status === 0 };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const cases = [
  ['rh desktop window list', 'rh', ['desktop', 'window', 'list']],
  ['rh desktop snapshot --no-ocr', 'rh', ['desktop', 'snapshot', '--no-ocr']],
  ['rh browser tabs', 'rh', ['browser', 'tabs']],
  [
    'agy cold turn (flash, low)',
    'agy',
    ['-p', 'reply with the single word ok', '--model', 'gemini-3.8-flash', '--effort', 'low', '--output-format', 'stream-json'],
  ],
];

for (const [name, cmd, args] of cases) {
  const samples = [];
  const n = name.startsWith('agy') ? Math.min(runs, 3) : runs;
  for (let i = 0; i < n; i += 1) {
    const { ms, ok } = timeMs(cmd, args);
    if (ok) samples.push(ms);
  }
  const med = samples.length ? Math.round(median(samples)) : 'FAILED';
  console.log(`${name.padEnd(34)} ${String(med).padStart(7)} ms  (${samples.length}/${n} ok)`);
}
```

- [ ] **Step 2: Run it and save the baseline**

Run: `node scripts/bench-actions.mjs 5 | tee /private/tmp/claude-501/-Users-kushal-Desktop-project-remote-hands/924b3783-7f50-4084-99cf-5c17e093c09b/scratchpad/bench-before.txt`
Expected: four lines, desktop snapshot around 1000-1500 ms.

- [ ] **Step 3: Commit**

```bash
git add scripts/bench-actions.mjs
git commit -m "chore: add action latency benchmark script" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Cached Swift binaries (`fastExec`)

**Files:**
- Create: `packages/daemon/src/desktop/fast-exec.ts`
- Create: `packages/daemon/src/desktop/fast-exec.test.ts`
- Modify: `packages/daemon/src/desktop/macos-driver.ts:63-68` (constructor default exec)
- Modify: `packages/daemon/src/desktop/ax-walker.ts:42-59` (constructor, three inline `spawnSync` defaults)
- Modify: `packages/daemon/src/desktop/ax-actions.ts:12-15` (`defaultExec`)
- Modify: `packages/daemon/src/desktop/menu-crawler.ts:10-13` (`defaultExec`)
- Modify: `packages/daemon/src/index.ts` (export `fast-exec`)

**Interfaces:**
- Consumes: `ExecFunction` from `./macos-driver.js` (`(command, args) => { stdout, stderr, status }`).
- Produces:
  - `hoistSwiftParams(script: string): { template: string; env: Record<string, string>; hoisted: boolean }`
  - `createFastExec(options?: { cacheDir?: string; spawn?: SpawnFn }): ExecFunction`
  - `fastExec: ExecFunction` (shared default)
  - `type SpawnFn = (command: string, args: string[], env?: Record<string, string>) => { stdout: string; stderr: string; status: number | null }`

How it works: scripts embed per-call parameters as top-level lines such as `let query = "Finder"`, `let targetIndex = 5`, `let hasBounds = true`, `let action = "AXPress" as CFString`, `let itemQuery = "Save".lowercased()`. `hoistSwiftParams` rewrites each such literal into a read of environment variable `RH_P_<name>` through small prelude helpers, so the template text is identical across calls and can be compiled once.

- [ ] **Step 1: Write the failing unit tests**

```ts
// packages/daemon/src/desktop/fast-exec.test.ts
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hoistSwiftParams, createFastExec, type SpawnFn } from './fast-exec.js';

const SCRIPT = [
  'import Cocoa',
  'let query = "Bambu \\"Studio\\""',
  'let targetIndex = 5',
  'let hasBounds = true',
  'let ratio = 1.5',
  'let action = "AXPress" as CFString',
  'let itemQuery = "Save".lowercased()',
  '    let indented = "keep"',
  'print(query)',
].join('\n');

describe('hoistSwiftParams', () => {
  it('replaces top-level literals with env reads and captures values', () => {
    const { template, env, hoisted } = hoistSwiftParams(SCRIPT);
    expect(hoisted).toBe(true);
    expect(env).toEqual({
      RH_P_query: 'Bambu "Studio"',
      RH_P_targetIndex: '5',
      RH_P_hasBounds: 'true',
      RH_P_ratio: '1.5',
      RH_P_action: 'AXPress',
      RH_P_itemQuery: 'Save',
    });
    expect(template).toContain('let query = rhStr("RH_P_query")');
    expect(template).toContain('let targetIndex = rhInt("RH_P_targetIndex")');
    expect(template).toContain('let hasBounds = rhBool("RH_P_hasBounds")');
    expect(template).toContain('let ratio = rhDouble("RH_P_ratio")');
    expect(template).toContain('let action = rhStr("RH_P_action") as CFString');
    expect(template).toContain('let itemQuery = rhStr("RH_P_itemQuery").lowercased()');
    expect(template).toContain('    let indented = "keep"');
  });

  it('produces identical templates for different parameter values', () => {
    const a = hoistSwiftParams('let query = "A"\nlet targetIndex = 1\n');
    const b = hoistSwiftParams('let query = "B"\nlet targetIndex = 99\n');
    expect(a.template).toBe(b.template);
    expect(a.env.RH_P_query).toBe('A');
    expect(b.env.RH_P_targetIndex).toBe('99');
  });

  it('refuses to hoist when a name repeats', () => {
    const { hoisted, template, env } = hoistSwiftParams('let query = "A"\nlet query = "B"\n');
    expect(hoisted).toBe(false);
    expect(env).toEqual({});
    expect(template).toBe('let query = "A"\nlet query = "B"\n');
  });

  it('leaves string literals with unsupported escapes untouched', () => {
    const { template, env } = hoistSwiftParams('let query = "a\\nb"\n');
    expect(env).toEqual({});
    expect(template).toBe('let query = "a\\nb"\n');
  });
});

describe('createFastExec', () => {
  function makeSpawn() {
    const calls: Array<{ command: string; args: string[]; env?: Record<string, string> | undefined }> = [];
    const spawn: SpawnFn = vi.fn((command, args, env) => {
      calls.push({ command, args, env });
      if (command === 'swiftc') {
        const out = args[args.indexOf('-o') + 1]!;
        fs.writeFileSync(out, '#!/bin/sh\necho compiled');
        return { stdout: '', stderr: '', status: 0 };
      }
      return { stdout: 'ran', stderr: '', status: 0 };
    });
    return { spawn, calls };
  }

  it('passes non-swift commands straight through', () => {
    const { spawn, calls } = makeSpawn();
    const exec = createFastExec({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')), spawn });
    expect(exec('osascript', ['-e', 'x']).stdout).toBe('ran');
    expect(calls).toEqual([{ command: 'osascript', args: ['-e', 'x'], env: undefined }]);
  });

  it('compiles once per template and reuses the binary with new env', () => {
    const { spawn, calls } = makeSpawn();
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-'));
    const exec = createFastExec({ cacheDir, spawn });
    exec('swift', ['-e', 'let query = "A"\nprint(query)\n']);
    exec('swift', ['-e', 'let query = "B"\nprint(query)\n']);
    const compiles = calls.filter((c) => c.command === 'swiftc');
    expect(compiles).toHaveLength(1);
    const runs = calls.filter((c) => c.command !== 'swiftc');
    expect(runs).toHaveLength(2);
    expect(runs[0]!.env).toEqual({ RH_P_query: 'A' });
    expect(runs[1]!.env).toEqual({ RH_P_query: 'B' });
  });

  it('falls back to swift -e when compilation fails', () => {
    const calls: string[] = [];
    const spawn: SpawnFn = (command) => {
      calls.push(command);
      if (command === 'swiftc') return { stdout: '', stderr: 'boom', status: 1 };
      return { stdout: 'fallback', stderr: '', status: 0 };
    };
    const exec = createFastExec({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')), spawn });
    const res = exec('swift', ['-e', 'let query = "A"\n']);
    expect(res.stdout).toBe('fallback');
    expect(calls).toEqual(['swiftc', 'swift']);
  });

  it('falls back when the cache directory cannot be created', () => {
    const calls: string[] = [];
    const spawn: SpawnFn = (command) => {
      calls.push(command);
      return { stdout: 'fallback', stderr: '', status: 0 };
    };
    const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')), 'file');
    fs.writeFileSync(blocker, 'x');
    const exec = createFastExec({ cacheDir: path.join(blocker, 'nested'), spawn });
    expect(exec('swift', ['-e', 'let query = "A"\n']).stdout).toBe('fallback');
    expect(calls).toEqual(['swift']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/daemon/src/desktop/fast-exec.test.ts`
Expected: FAIL, cannot find module `./fast-exec.js`.

- [ ] **Step 3: Implement `fast-exec.ts`**

```ts
// packages/daemon/src/desktop/fast-exec.ts
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExecFunction } from './macos-driver.js';

export interface SpawnResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

export type SpawnFn = (command: string, args: string[], env?: Record<string, string>) => SpawnResult;

const realSpawn: SpawnFn = (command, args, env) => {
  const res = spawnSync(command, args, {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
};

const SWIFT_PRELUDE = [
  'import Foundation',
  'func rhEnv(_ k: String) -> String { ProcessInfo.processInfo.environment[k] ?? "" }',
  'func rhStr(_ k: String) -> String { rhEnv(k) }',
  'func rhInt(_ k: String) -> Int { Int(rhEnv(k)) ?? 0 }',
  'func rhDouble(_ k: String) -> Double { Double(rhEnv(k)) ?? 0 }',
  'func rhBool(_ k: String) -> Bool { rhEnv(k) == "true" }',
  '',
].join('\n');

// A top-level `let|var name = <literal>` line, optionally followed by `as CFxxx` or `.lowercased()`.
const PARAM_LINE =
  /^(let|var) ([A-Za-z_]\w*) = ("(?:[^"\\\n]|\\["\\])*"|-?\d+(?:\.\d+)?|true|false)(?=[ \t]*$|[ \t]+as[ \t]+\w+[ \t]*$|\.lowercased\(\)[ \t]*$)/gm;

export function hoistSwiftParams(script: string): {
  template: string;
  env: Record<string, string>;
  hoisted: boolean;
} {
  const env: Record<string, string> = {};
  const seen = new Set<string>();
  let duplicate = false;
  const body = script.replace(PARAM_LINE, (_match, keyword: string, name: string, literal: string) => {
    if (seen.has(name)) {
      duplicate = true;
      return _match;
    }
    seen.add(name);
    const key = `RH_P_${name}`;
    if (literal.startsWith('"')) {
      env[key] = literal.slice(1, -1).replace(/\\(["\\])/g, '$1');
      return `${keyword} ${name} = rhStr("${key}")`;
    }
    env[key] = literal;
    if (literal === 'true' || literal === 'false') return `${keyword} ${name} = rhBool("${key}")`;
    if (literal.includes('.')) return `${keyword} ${name} = rhDouble("${key}")`;
    return `${keyword} ${name} = rhInt("${key}")`;
  });
  if (duplicate) return { template: script, env: {}, hoisted: false };
  return { template: SWIFT_PRELUDE + body, env, hoisted: Object.keys(env).length > 0 };
}

export function defaultSwiftCacheDir(): string {
  return path.join(os.homedir(), '.remote-hands', 'swift-cache');
}

export interface FastExecOptions {
  cacheDir?: string;
  spawn?: SpawnFn;
}

export function createFastExec(options: FastExecOptions = {}): ExecFunction {
  const run = options.spawn ?? realSpawn;
  const cacheDir = options.cacheDir ?? defaultSwiftCacheDir();

  return (command, args) => {
    if (command !== 'swift' || args[0] !== '-e' || typeof args[1] !== 'string') {
      return run(command, args);
    }
    const script = args[1];
    const { template, env } = hoistSwiftParams(script);
    const hash = createHash('sha256').update(template).digest('hex').slice(0, 24);
    const dir = path.join(cacheDir, hash);
    const bin = path.join(dir, 'bin');
    try {
      if (!fs.existsSync(bin)) {
        fs.mkdirSync(dir, { recursive: true });
        const source = path.join(dir, 'main.swift');
        fs.writeFileSync(source, template);
        const tmpBin = `${bin}.${process.pid}.tmp`;
        const compiled = run('swiftc', ['-O', source, '-o', tmpBin]);
        if (compiled.status !== 0 || !fs.existsSync(tmpBin)) {
          fs.rmSync(tmpBin, { force: true });
          return run(command, args);
        }
        fs.renameSync(tmpBin, bin);
      }
    } catch {
      return run(command, args);
    }
    return run(bin, [], env);
  };
}

export const fastExec: ExecFunction = createFastExec();
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/daemon/src/desktop/fast-exec.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Wire `fastExec` in as the default**

In `macos-driver.ts`, replace the constructor default:

```ts
  constructor(options?: MacOsDriverOptions) {
    this.exec = options?.exec ?? fastExec;
  }
```

and add `import { fastExec } from './fast-exec.js';` at the top. In `ax-actions.ts` and `menu-crawler.ts`, replace the `defaultExec` constant body with `const defaultExec: ExecFunction = fastExec;` (keep the name) and drop the now-unused `spawnSync` import if nothing else uses it. In `ax-walker.ts`, replace the three inline `(cmd, args) => { const res = spawnSync(...) ... }` defaults (lines 46-59) with `fastExec`:

```ts
  constructor(options?: AxWalkerOptions | MacOsDriver) {
    if (options && 'openApp' in options) {
      this.exec = options.exec;
    } else if (options && typeof options === 'object') {
      this.exec = options.exec ?? options.driver?.exec ?? fastExec;
      if (typeof options.allowOcr === 'boolean') {
        this.allowOcr = options.allowOcr;
      }
    } else {
      this.exec = fastExec;
    }
  }
```

Add `export * from './desktop/fast-exec.js';` to `packages/daemon/src/index.ts`.

- [ ] **Step 6: Add the darwin-only real-compile test**

This is the safety net for the regex hoisting: it type-checks the hoisted template of every real Swift script in the repo with the real `swiftc`.

```ts
// packages/daemon/src/desktop/fast-exec.integration.test.ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExecFunction } from './macos-driver.js';
import { hoistSwiftParams } from './fast-exec.js';
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
```

Run: `npx vitest run packages/daemon/src/desktop/fast-exec.integration.test.ts`
Expected: PASS. If a template fails type-check (for example `String as CFTypeRef`), fix the hoister for that shape (for example by adding an explicit bridging suffix to the replacement) and add a unit case to `fast-exec.test.ts` for it. Do not skip the failing script.

- [ ] **Step 7: Run all desktop tests**

Run: `npx vitest run packages/daemon/src/desktop packages/cli/src/commands/desktop.test.ts`
Expected: PASS.

- [ ] **Step 8: Measure**

Run (twice; the first run compiles): `rh` is the installed bundle, so use the repo build instead:
`npm run build && node packages/cli/dist/index.js desktop snapshot --no-ocr > /dev/null; time node packages/cli/dist/index.js desktop snapshot --no-ocr > /dev/null`
Expected: second run under 600 ms total (was 1350 ms).

- [ ] **Step 9: Commit**

```bash
git add packages/daemon/src/desktop packages/daemon/src/index.ts
git commit -m "perf(desktop): cache compiled swift binaries instead of swift -e" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Compact state and `ComputerSession`

**Files:**
- Create: `packages/daemon/src/computer/compact.ts`
- Create: `packages/daemon/src/computer/compact.test.ts`
- Create: `packages/daemon/src/computer/session.ts`
- Create: `packages/daemon/src/computer/session.test.ts`

**Interfaces:**
- Consumes: `IndexedElement` from `../desktop/ax-walker.js` (`{ index, role, label, bounds: [x, y, w, h] }`); `MacOsDriver`, `AxWalker`, `performAxAction`, `searchAndTriggerMenu`, `BrowserDriver` (`listTabs`, `focusTab`, `openUrl`, `snapshot`, `clickIndex`, `typeIndex`).
- Produces:
  - `compactDesktopElements(elements: IndexedElement[], opts?: { max?: number; filter?: string }): string`
  - `capLines(text: string, max: number): string`
  - `class ComputerSession` with methods, all returning `Promise<string>`: `desktopSnapshot(app?, filter?)`, `desktopClick(index, app?)`, `desktopType(text, app?)`, `desktopKey(combo, app?)`, `desktopOpen(app)`, `desktopMenu(app, query)`, `desktopWindows()`, `browserTabs()`, `browserFocus(target)`, `browserOpen(url)`, `browserSnapshot()`, `browserClick(index)`, `browserType(index, text)`
  - `interface ComputerSessionDeps` (shape in Step 3)
  - `createDefaultComputerSession(): ComputerSession` (real drivers)

- [ ] **Step 1: Write the failing tests for `compact.ts`**

```ts
// packages/daemon/src/computer/compact.test.ts
import { describe, it, expect } from 'vitest';
import { compactDesktopElements, capLines } from './compact.js';
import type { IndexedElement } from '../desktop/ax-walker.js';

const el = (index: number, role: string, label: string): IndexedElement => ({
  index,
  role,
  label,
  bounds: [0, 0, 10, 10],
});

describe('compactDesktopElements', () => {
  it('drops unlabeled noise roles, strips the AX prefix and keeps original indexes', () => {
    const out = compactDesktopElements([
      el(1, 'AXStaticText', ''),
      el(2, 'AXButton', 'Next'),
      el(3, 'AXGroup', ''),
      el(4, 'AXTextField', 'Email'),
    ]);
    expect(out).toBe('[2] Button "Next"\n[4] TextField "Email"');
  });

  it('collapses consecutive duplicates and truncates long labels', () => {
    const long = 'x'.repeat(100);
    const out = compactDesktopElements([el(1, 'AXLink', 'Home'), el(2, 'AXLink', 'Home'), el(3, 'AXButton', long)]);
    expect(out.split('\n')).toEqual(['[1] Link "Home"', `[3] Button "${'x'.repeat(59)}…"`]);
  });

  it('caps the number of lines and reports how many were hidden', () => {
    const many = Array.from({ length: 10 }, (_, i) => el(i + 1, 'AXButton', `b${i}`));
    const out = compactDesktopElements(many, { max: 3 });
    expect(out.split('\n')).toHaveLength(4);
    expect(out).toContain('… 7 more elements hidden; pass filter to narrow');
  });

  it('filters by case-insensitive substring of role or label', () => {
    const out = compactDesktopElements([el(1, 'AXButton', 'Save'), el(2, 'AXButton', 'Cancel')], { filter: 'sav' });
    expect(out).toBe('[1] Button "Save"');
  });

  it('says so when nothing is left', () => {
    expect(compactDesktopElements([])).toBe('(no interactive elements found)');
  });
});

describe('capLines', () => {
  it('returns short text unchanged and truncates long text with a note', () => {
    expect(capLines('a\nb', 5)).toBe('a\nb');
    expect(capLines('a\nb\nc\nd', 2)).toBe('a\nb\n… 2 more lines hidden');
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement `compact.ts`**

Run: `npx vitest run packages/daemon/src/computer/compact.test.ts` (FAIL, module missing). Then:

```ts
// packages/daemon/src/computer/compact.ts
import type { IndexedElement } from '../desktop/ax-walker.js';

const NOISE_ROLES = new Set([
  'AXStaticText',
  'AXGroup',
  'AXUnknown',
  'AXImage',
  'AXScrollArea',
  'AXSplitGroup',
  'AXLayoutArea',
  'AXLayoutItem',
]);

const MAX_LABEL = 60;

export function compactDesktopElements(
  elements: IndexedElement[],
  opts: { max?: number; filter?: string } = {},
): string {
  const max = opts.max ?? 80;
  const filter = opts.filter?.trim().toLowerCase();
  const lines: string[] = [];
  let previous = '';
  for (const element of elements) {
    const label = element.label.replace(/\s+/g, ' ').trim();
    if (!label && NOISE_ROLES.has(element.role)) continue;
    const role = element.role.replace(/^AX/, '');
    if (filter && !`${role} ${label}`.toLowerCase().includes(filter)) continue;
    const shown = label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label;
    const line = `[${element.index}] ${role} "${shown}"`;
    const identity = `${role}|${shown}`;
    if (identity === previous) continue;
    previous = identity;
    lines.push(line);
  }
  if (lines.length === 0) return '(no interactive elements found)';
  if (lines.length > max) {
    const hidden = lines.length - max;
    return [...lines.slice(0, max), `… ${hidden} more elements hidden; pass filter to narrow`].join('\n');
  }
  return lines.join('\n');
}

export function capLines(text: string, max: number): string {
  const lines = text.split('\n');
  if (lines.length <= max) return text;
  return [...lines.slice(0, max), `… ${lines.length - max} more lines hidden`].join('\n');
}
```

Run again. Expected: PASS.

- [ ] **Step 3: Write the failing tests for `ComputerSession`**

```ts
// packages/daemon/src/computer/session.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ComputerSession, type ComputerSessionDeps } from './session.js';

function makeDeps(overrides: Partial<ComputerSessionDeps> = {}) {
  const elements = [
    { index: 1, role: 'AXButton', label: 'Next', bounds: [10, 20, 100, 40] as [number, number, number, number] },
    { index: 2, role: 'AXTextField', label: 'Email', bounds: [0, 0, 50, 20] as [number, number, number, number] },
  ];
  const deps: ComputerSessionDeps = {
    desktop: {
      openApp: vi.fn().mockResolvedValue(undefined),
      focusWindow: vi.fn().mockResolvedValue(undefined),
      clickAt: vi.fn().mockResolvedValue(undefined),
      typeText: vi.fn().mockResolvedValue(undefined),
      sendKeyCombo: vi.fn().mockResolvedValue(undefined),
      listWindows: vi.fn().mockResolvedValue([{ app: 'Finder', title: 'Docs' }]),
    },
    walker: { walkActiveApp: vi.fn().mockResolvedValue(elements) },
    axAction: vi.fn().mockResolvedValue(true),
    menuSearch: vi.fn().mockResolvedValue({ success: true, triggeredPath: ['File', 'Save'] }),
    browser: {
      listTabs: vi.fn().mockResolvedValue([
        { id: 't1', title: 'Inbox', url: 'https://mail.example', active: true, windowIndex: 1, tabIndex: 2 },
      ]),
      focusTab: vi.fn().mockResolvedValue({ success: true, tab: { title: 'Inbox', url: 'https://mail.example' } }),
      openUrl: vi.fn().mockResolvedValue({ success: true, url: 'https://x.test' }),
      snapshot: vi.fn().mockResolvedValue({ url: 'u', title: 't', elements: [], formattedTable: '[1] button "Go"' }),
      clickIndex: vi.fn().mockResolvedValue({ success: true, label: 'Go' }),
      typeIndex: vi.fn().mockResolvedValue({ success: true, label: 'Email' }),
    },
    settleMs: 0,
    sleep: async () => {},
    ...overrides,
  };
  return deps;
}

describe('ComputerSession desktop', () => {
  it('snapshot walks once, caches, and returns a header plus compact lines', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    const out = await s.desktopSnapshot('Finder');
    expect(out).toBe('app: Finder\n[1] Button "Next"\n[2] TextField "Email"');
    expect(deps.walker.walkActiveApp).toHaveBeenCalledTimes(1);
  });

  it('click uses the cached element without re-walking first, then returns fresh state', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    await s.desktopSnapshot('Finder');
    const out = await s.desktopClick(1, 'Finder');
    expect(deps.axAction).toHaveBeenCalledWith(
      'Finder',
      { index: 1, bounds: [10, 20, 100, 40], role: 'AXButton', label: 'Next' },
      'AXPress',
    );
    expect(deps.walker.walkActiveApp).toHaveBeenCalledTimes(2);
    expect(out.startsWith('clicked [1] Button "Next"')).toBe(true);
    expect(out).toContain('[2] TextField "Email"');
  });

  it('click without a cached snapshot errors and tells the model to snapshot', async () => {
    const s = new ComputerSession(makeDeps());
    await expect(s.desktopClick(1)).rejects.toThrow('No snapshot cached. Call desktop_snapshot first.');
  });

  it('click with an index missing from the cache errors instead of guessing', async () => {
    const s = new ComputerSession(makeDeps());
    await s.desktopSnapshot('Finder');
    await expect(s.desktopClick(99, 'Finder')).rejects.toThrow('Index 99 not in last snapshot. Call desktop_snapshot again.');
  });

  it('falls back to a coordinate click at the element center and says so', async () => {
    const deps = makeDeps({ axAction: vi.fn().mockResolvedValue(false) });
    const s = new ComputerSession(deps);
    await s.desktopSnapshot('Finder');
    const out = await s.desktopClick(1, 'Finder');
    expect(deps.desktop.clickAt).toHaveBeenCalledWith(60, 40);
    expect(out).toContain('AX press failed; used physical click at 60,40');
  });

  it('key parses combos into key and modifiers', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    await s.desktopKey('cmd+shift+s');
    expect(deps.desktop.sendKeyCombo).toHaveBeenCalledWith(['s'], ['command', 'shift']);
    await s.desktopKey('return');
    expect(deps.desktop.sendKeyCombo).toHaveBeenCalledWith(['return'], []);
  });

  it('type, open and menu return fresh state', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    expect(await s.desktopType('hello', 'Finder')).toContain('typed 5 characters');
    expect(deps.desktop.typeText).toHaveBeenCalledWith('hello');
    expect(await s.desktopOpen('Finder')).toContain('opened Finder');
    expect(await s.desktopMenu('Finder', 'save')).toContain('menu File > Save');
  });

  it('menu reports failure without throwing a stack', async () => {
    const deps = makeDeps({ menuSearch: vi.fn().mockResolvedValue({ success: false, error: 'No match' }) });
    const s = new ComputerSession(deps);
    await expect(s.desktopMenu('Finder', 'zzz')).rejects.toThrow('No match');
  });
});

describe('ComputerSession browser', () => {
  it('tabs lists window/tab ids, active marker, title and url', async () => {
    const s = new ComputerSession(makeDeps());
    expect(await s.browserTabs()).toBe('[w1-t2] (active) Inbox - https://mail.example');
  });

  it('click returns the page state after the click', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    const out = await s.browserClick(1);
    expect(deps.browser.clickIndex).toHaveBeenCalledWith(1);
    expect(out).toBe('clicked [1] Go\n[1] button "Go"');
  });

  it('type returns the page state after typing', async () => {
    const deps = makeDeps();
    const out = await new ComputerSession(deps).browserType(2, 'a@b.c');
    expect(deps.browser.typeIndex).toHaveBeenCalledWith(2, 'a@b.c');
    expect(out).toBe('typed into [2] Email\n[1] button "Go"');
  });

  it('snapshot caps very long tables', async () => {
    const table = Array.from({ length: 300 }, (_, i) => `[${i}] link "l${i}"`).join('\n');
    const deps = makeDeps();
    deps.browser.snapshot = vi.fn().mockResolvedValue({ url: 'u', title: 't', elements: [], formattedTable: table });
    const out = await new ComputerSession(deps).browserSnapshot();
    expect(out.split('\n')).toHaveLength(121);
    expect(out).toContain('… 180 more lines hidden');
  });
});
```

- [ ] **Step 4: Run to verify failure, then implement `session.ts`**

Run: `npx vitest run packages/daemon/src/computer/session.test.ts` (FAIL). Then:

```ts
// packages/daemon/src/computer/session.ts
import type { IndexedElement } from '../desktop/ax-walker.js';
import { AxWalker } from '../desktop/ax-walker.js';
import { performAxAction } from '../desktop/ax-actions.js';
import { searchAndTriggerMenu } from '../desktop/menu-crawler.js';
import { MacOsDriver } from '../desktop/macos-driver.js';
import { BrowserDriver } from '../browser-driver.js';
import { capLines, compactDesktopElements } from './compact.js';

export interface ComputerSessionDeps {
  desktop: Pick<
    MacOsDriver,
    'openApp' | 'focusWindow' | 'clickAt' | 'typeText' | 'sendKeyCombo' | 'listWindows'
  >;
  walker: Pick<AxWalker, 'walkActiveApp'>;
  axAction: typeof performAxAction;
  menuSearch: typeof searchAndTriggerMenu;
  browser: Pick<BrowserDriver, 'listTabs' | 'focusTab' | 'openUrl' | 'snapshot' | 'clickIndex' | 'typeIndex'>;
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const MODIFIER_NAMES: Record<string, string> = {
  cmd: 'command',
  command: 'command',
  shift: 'shift',
  alt: 'option',
  opt: 'option',
  option: 'option',
  ctrl: 'control',
  control: 'control',
};

const BROWSER_MAX_LINES = 120;

export class ComputerSession {
  private cache: { app: string; elements: IndexedElement[] } | null = null;

  constructor(private readonly deps: ComputerSessionDeps) {}

  private async settle(): Promise<void> {
    const ms = this.deps.settleMs ?? 150;
    if (ms > 0) await (this.deps.sleep ?? ((n) => new Promise((r) => setTimeout(r, n))))(ms);
  }

  private async walk(app?: string): Promise<IndexedElement[]> {
    const elements = await this.deps.walker.walkActiveApp(app, { allowOcr: false });
    this.cache = { app: app ?? '', elements };
    return elements;
  }

  private async state(app?: string): Promise<string> {
    await this.settle();
    return compactDesktopElements(await this.walk(app));
  }

  async desktopSnapshot(app?: string, filter?: string): Promise<string> {
    const elements = await this.walk(app);
    const header = `app: ${app ?? '(frontmost)'}`;
    return `${header}\n${compactDesktopElements(elements, filter ? { filter } : {})}`;
  }

  async desktopClick(index: number, app?: string): Promise<string> {
    if (!this.cache) throw new Error('No snapshot cached. Call desktop_snapshot first.');
    const element = this.cache.elements.find((e) => e.index === index);
    if (!element) throw new Error(`Index ${index} not in last snapshot. Call desktop_snapshot again.`);
    const targetApp = app ?? this.cache.app;
    const described = `[${element.index}] ${element.role.replace(/^AX/, '')} "${element.label}"`;
    const pressed = await this.deps.axAction(
      targetApp,
      { index: element.index, bounds: element.bounds, role: element.role, label: element.label },
      'AXPress',
    );
    let note = '';
    if (!pressed) {
      const [x, y, w, h] = element.bounds;
      const cx = Math.round(x + w / 2);
      const cy = Math.round(y + h / 2);
      await this.deps.desktop.clickAt(cx, cy);
      note = `\nnote: AX press failed; used physical click at ${cx},${cy}`;
    }
    return `clicked ${described}${note}\n${await this.state(targetApp || undefined)}`;
  }

  async desktopType(text: string, app?: string): Promise<string> {
    await this.deps.desktop.typeText(text);
    return `typed ${text.length} characters\n${await this.state(app ?? (this.cache?.app || undefined))}`;
  }

  async desktopKey(combo: string, app?: string): Promise<string> {
    const parts = combo
      .toLowerCase()
      .split('+')
      .map((p) => p.trim())
      .filter(Boolean);
    const key = parts.pop();
    if (!key) throw new Error(`Invalid key combo "${combo}"`);
    const modifiers = parts.map((p) => {
      const mapped = MODIFIER_NAMES[p];
      if (!mapped) throw new Error(`Unknown modifier "${p}" in "${combo}"`);
      return mapped;
    });
    await this.deps.desktop.sendKeyCombo([key], modifiers);
    return `pressed ${combo}\n${await this.state(app ?? (this.cache?.app || undefined))}`;
  }

  async desktopOpen(app: string): Promise<string> {
    await this.deps.desktop.openApp(app);
    await this.deps.desktop.focusWindow(app).catch(() => {});
    return `opened ${app}\n${await this.state(app)}`;
  }

  async desktopMenu(app: string, query: string): Promise<string> {
    const res = await this.deps.menuSearch(app, query);
    if (!res.success) throw new Error(res.error ?? `No menu item matching "${query}" in ${app}`);
    return `menu ${(res.triggeredPath ?? []).join(' > ')}\n${await this.state(app)}`;
  }

  async desktopWindows(): Promise<string> {
    const wins = await this.deps.desktop.listWindows();
    return wins.map((w) => `${w.app} - ${w.title}`).join('\n') || '(no windows)';
  }

  async browserTabs(): Promise<string> {
    const tabs = await this.deps.browser.listTabs();
    return tabs
      .map((t) => `[w${t.windowIndex ?? 1}-t${t.tabIndex ?? '?'}] ${t.active ? '(active) ' : ''}${t.title} - ${t.url}`)
      .join('\n');
  }

  async browserFocus(target: string | number): Promise<string> {
    const res = await this.deps.browser.focusTab(target);
    return `focused ${res.tab.title} - ${res.tab.url}\n${await this.browserSnapshot()}`;
  }

  async browserOpen(url: string): Promise<string> {
    const res = await this.deps.browser.openUrl(url);
    return `opened ${res.url}\n${await this.browserSnapshot()}`;
  }

  async browserSnapshot(): Promise<string> {
    const snap = await this.deps.browser.snapshot();
    return capLines(snap.formattedTable, BROWSER_MAX_LINES);
  }

  async browserClick(index: number): Promise<string> {
    const res = await this.deps.browser.clickIndex(index);
    await this.settle();
    return `clicked [${index}] ${res.label}\n${await this.browserSnapshot()}`;
  }

  async browserType(index: number, text: string): Promise<string> {
    const res = await this.deps.browser.typeIndex(index, text);
    await this.settle();
    return `typed into [${index}] ${res.label}\n${await this.browserSnapshot()}`;
  }
}

export function createDefaultComputerSession(): ComputerSession {
  const desktop = new MacOsDriver();
  return new ComputerSession({
    desktop,
    walker: new AxWalker({ driver: desktop }),
    axAction: performAxAction,
    menuSearch: searchAndTriggerMenu,
    browser: new BrowserDriver({ cdpUrl: process.env.BU_CDP_URL || 'http://127.0.0.1:9222' }),
  });
}
```

Expected formatting detail the tests rely on: `clicked [1] Button "Next"` uses `element.role.replace(/^AX/, '')`; browser `clicked [1] Go` has no quotes.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run packages/daemon/src/computer`
Expected: PASS. Then `npm run build` must typecheck; fix type errors in `session.ts` if `WindowInfo` field names differ from `app`/`title` (check `macos-driver.ts:6-10`).

- [ ] **Step 6: Export and commit**

Add to `packages/daemon/src/index.ts`:

```ts
export * from './computer/compact.js';
export * from './computer/session.js';
```

```bash
git add packages/daemon/src/computer packages/daemon/src/index.ts
git commit -m "feat(computer): compact state output and warm ComputerSession" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: MCP tools, stdio server and `rh mcp`

**Files:**
- Modify: `packages/daemon/package.json` (add dependency)
- Create: `packages/daemon/src/computer/tools.ts`
- Create: `packages/daemon/src/computer/tools.test.ts`
- Create: `packages/daemon/src/computer/mcp-server.ts`
- Create: `packages/daemon/src/computer/mcp-server.test.ts`
- Create: `packages/cli/src/commands/mcp.ts`
- Create: `packages/cli/src/commands/mcp.test.ts`
- Modify: `packages/cli/src/index.ts` (import, export, route `mcp`, help line)
- Modify: `packages/daemon/src/index.ts` (exports)

**Interfaces:**
- Consumes: `ComputerSession` and `createDefaultComputerSession` from Task 3.
- Produces:
  - `interface ComputerTool { name: string; description: string; inputSchema: Record<string, z.ZodType>; handler(args: any): Promise<string> }`
  - `buildComputerTools(session: ComputerSession): ComputerTool[]`
  - `createComputerMcpServer(tools: ComputerTool[]): McpServer`
  - `serveComputerMcp(session: ComputerSession): Promise<void>`
  - `mcpCommand(args: string[], context?: McpCommandContext): Promise<number>` with subcommands `serve` (default), `install`, `remove`
  - agy server name: `rh-computer`

- [ ] **Step 1: Add the SDK dependency**

Run: `npm install @modelcontextprotocol/sdk --workspace @remote-hands/daemon`
Expected: `packages/daemon/package.json` gains the dependency. Confirm it accepts zod 4: `npm ls zod @modelcontextprotocol/sdk`. If it complains about a zod peer range, use the newest SDK release that supports zod 4 rather than downgrading zod.

- [ ] **Step 2: Write the failing tests for the tools**

```ts
// packages/daemon/src/computer/tools.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildComputerTools } from './tools.js';
import type { ComputerSession } from './session.js';

function fakeSession() {
  return {
    desktopSnapshot: vi.fn().mockResolvedValue('snap'),
    desktopClick: vi.fn().mockResolvedValue('clicked'),
    desktopType: vi.fn().mockResolvedValue('typed'),
    desktopKey: vi.fn().mockResolvedValue('pressed'),
    desktopOpen: vi.fn().mockResolvedValue('opened'),
    desktopMenu: vi.fn().mockResolvedValue('menu'),
    desktopWindows: vi.fn().mockResolvedValue('wins'),
    browserTabs: vi.fn().mockResolvedValue('tabs'),
    browserFocus: vi.fn().mockResolvedValue('focused'),
    browserOpen: vi.fn().mockResolvedValue('opened url'),
    browserSnapshot: vi.fn().mockResolvedValue('bsnap'),
    browserClick: vi.fn().mockResolvedValue('bclicked'),
    browserType: vi.fn().mockResolvedValue('btyped'),
  } as unknown as ComputerSession & Record<string, ReturnType<typeof vi.fn>>;
}

describe('buildComputerTools', () => {
  it('exposes the expected tool names', () => {
    const names = buildComputerTools(fakeSession()).map((t) => t.name).sort();
    expect(names).toEqual([
      'browser_click',
      'browser_focus',
      'browser_open',
      'browser_snapshot',
      'browser_tabs',
      'browser_type',
      'computer_batch',
      'desktop_click',
      'desktop_key',
      'desktop_menu',
      'desktop_open',
      'desktop_snapshot',
      'desktop_type',
      'desktop_windows',
    ]);
  });

  it('routes handler arguments to the session', async () => {
    const session = fakeSession();
    const tool = (name: string) => buildComputerTools(session).find((t) => t.name === name)!;
    await tool('desktop_click').handler({ index: 4, app: 'Finder' });
    expect(session.desktopClick).toHaveBeenCalledWith(4, 'Finder');
    await tool('browser_type').handler({ index: 2, text: 'hi' });
    expect(session.browserType).toHaveBeenCalledWith(2, 'hi');
    await tool('desktop_snapshot').handler({ filter: 'save' });
    expect(session.desktopSnapshot).toHaveBeenCalledWith(undefined, 'save');
  });

  it('batch runs steps in order and returns the last state', async () => {
    const session = fakeSession();
    const batch = buildComputerTools(session).find((t) => t.name === 'computer_batch')!;
    const out = await batch.handler({
      steps: [
        { tool: 'desktop_type', args: { text: 'a' } },
        { tool: 'desktop_key', args: { combo: 'tab' } },
      ],
    });
    expect(session.desktopType).toHaveBeenCalledWith('a', undefined);
    expect(session.desktopKey).toHaveBeenCalledWith('tab', undefined);
    expect(out).toBe('step 1 desktop_type ok\nstep 2 desktop_key ok\npressed');
  });

  it('batch stops at the first failing step and reports it', async () => {
    const session = fakeSession();
    session.desktopKey = vi.fn().mockRejectedValue(new Error('bad combo'));
    const batch = buildComputerTools(session).find((t) => t.name === 'computer_batch')!;
    await expect(
      batch.handler({
        steps: [
          { tool: 'desktop_type', args: { text: 'a' } },
          { tool: 'desktop_key', args: { combo: '??' } },
          { tool: 'desktop_type', args: { text: 'never' } },
        ],
      }),
    ).rejects.toThrow('step 2 desktop_key failed: bad combo (step 1 ok; steps after 2 not run)');
    expect(session.desktopType).toHaveBeenCalledTimes(1);
  });

  it('batch rejects nested batches and unknown tools', async () => {
    const batch = buildComputerTools(fakeSession()).find((t) => t.name === 'computer_batch')!;
    await expect(batch.handler({ steps: [{ tool: 'computer_batch', args: {} }] })).rejects.toThrow(
      'step 1 computer_batch failed: unknown or nested tool',
    );
  });
});
```

- [ ] **Step 3: Run to verify failure, then implement `tools.ts`**

Run: `npx vitest run packages/daemon/src/computer/tools.test.ts` (FAIL). Then:

```ts
// packages/daemon/src/computer/tools.ts
import { z } from 'zod';
import type { ComputerSession } from './session.js';

export interface ComputerTool {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  handler(args: any): Promise<string>;
}

const app = z.string().optional().describe('Application name. Omit for the frontmost app.');

export function buildComputerTools(session: ComputerSession): ComputerTool[] {
  const tools: ComputerTool[] = [
    {
      name: 'desktop_snapshot',
      description:
        'List interactive UI elements of a macOS app as "[index] Role \\"label\\"". Indexes are valid until the next snapshot or action. Use filter to search by role/label substring.',
      inputSchema: { app, filter: z.string().optional().describe('Case-insensitive substring of role or label.') },
      handler: (a) => session.desktopSnapshot(a.app, a.filter),
    },
    {
      name: 'desktop_click',
      description:
        'Press a UI element by index from the latest desktop_snapshot using native Accessibility (no mouse movement). Returns the new UI state, so a separate snapshot is not needed.',
      inputSchema: { index: z.number().int().describe('Index from the latest snapshot.'), app },
      handler: (a) => session.desktopClick(a.index, a.app),
    },
    {
      name: 'desktop_type',
      description: 'Type text into the focused element. Returns the new UI state.',
      inputSchema: { text: z.string(), app },
      handler: (a) => session.desktopType(a.text, a.app),
    },
    {
      name: 'desktop_key',
      description: 'Press a key or shortcut such as "return", "tab", "cmd+s", "cmd+shift+t". Returns the new UI state.',
      inputSchema: { combo: z.string(), app },
      handler: (a) => session.desktopKey(a.combo, a.app),
    },
    {
      name: 'desktop_open',
      description: 'Launch or activate an application and return its UI state.',
      inputSchema: { app: z.string() },
      handler: (a) => session.desktopOpen(a.app),
    },
    {
      name: 'desktop_menu',
      description: 'Fuzzy-search an app menu bar and trigger the best match, for example query "Export".',
      inputSchema: { app: z.string(), query: z.string() },
      handler: (a) => session.desktopMenu(a.app, a.query),
    },
    {
      name: 'desktop_windows',
      description: 'List open windows as "App - Title".',
      inputSchema: {},
      handler: () => session.desktopWindows(),
    },
    {
      name: 'browser_tabs',
      description: 'List Chrome tabs as "[wN-tM] (active) title - url".',
      inputSchema: {},
      handler: () => session.browserTabs(),
    },
    {
      name: 'browser_focus',
      description: 'Switch to an existing tab by index, url substring or title. Prefer this over opening duplicates.',
      inputSchema: { target: z.string().describe('Tab index, url substring or title.') },
      handler: (a) => session.browserFocus(/^\d+$/.test(a.target) ? Number(a.target) : a.target),
    },
    {
      name: 'browser_open',
      description: 'Open a URL (reuses a matching tab) and return the page state.',
      inputSchema: { url: z.string() },
      handler: (a) => session.browserOpen(a.url),
    },
    {
      name: 'browser_snapshot',
      description: 'List interactive page elements of the active tab as "[index] role \\"label\\"".',
      inputSchema: {},
      handler: () => session.browserSnapshot(),
    },
    {
      name: 'browser_click',
      description: 'Click a page element by index. Returns the new page state.',
      inputSchema: { index: z.number().int() },
      handler: (a) => session.browserClick(a.index),
    },
    {
      name: 'browser_type',
      description: 'Type text into a page element by index. Returns the new page state.',
      inputSchema: { index: z.number().int(), text: z.string() },
      handler: (a) => session.browserType(a.index, a.text),
    },
  ];

  const byName = new Map(tools.map((t) => [t.name, t]));

  tools.push({
    name: 'computer_batch',
    description:
      'Run several tool calls in one round trip, stopping at the first failure. Use for sequences that do not change element indexes (type, key, tab, open). After a click the page may re-layout, so end the batch there. Returns per-step status and the final state.',
    inputSchema: {
      steps: z
        .array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) }))
        .min(1)
        .max(12),
    },
    handler: async (a) => {
      const lines: string[] = [];
      let last = '';
      for (let i = 0; i < a.steps.length; i += 1) {
        const step = a.steps[i] as { tool: string; args: Record<string, unknown> };
        const n = i + 1;
        const tool = step.tool === 'computer_batch' ? undefined : byName.get(step.tool);
        if (!tool) throw new Error(`step ${n} ${step.tool} failed: unknown or nested tool`);
        try {
          last = await tool.handler(step.args ?? {});
        } catch (err: any) {
          const okSoFar = n === 1 ? 'no steps ok' : n === 2 ? 'step 1 ok' : `steps 1-${n - 1} ok`;
          const remaining = i < a.steps.length - 1 ? `; steps after ${n} not run` : '';
          throw new Error(`step ${n} ${step.tool} failed: ${err?.message ?? err} (${okSoFar}${remaining})`);
        }
        lines.push(`step ${n} ${step.tool} ok`);
      }
      return [...lines, last].join('\n');
    },
  });

  return tools;
}
```

Run the test again. Expected: PASS.

- [ ] **Step 4: Write the failing MCP server test (in-memory transport)**

```ts
// packages/daemon/src/computer/mcp-server.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createComputerMcpServer } from './mcp-server.js';
import type { ComputerTool } from './tools.js';

async function connect(tools: ComputerTool[]) {
  const server = createComputerMcpServer(tools);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe('createComputerMcpServer', () => {
  it('lists tools and returns handler text', async () => {
    const handler = vi.fn().mockResolvedValue('state text');
    const client = await connect([
      { name: 'echo', description: 'Echo', inputSchema: { text: z.string() }, handler },
    ]);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(['echo']);
    const res = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(handler).toHaveBeenCalledWith({ text: 'hi' });
    expect(res.content).toEqual([{ type: 'text', text: 'state text' }]);
    expect(res.isError).toBeFalsy();
  });

  it('turns handler exceptions into isError results', async () => {
    const client = await connect([
      { name: 'boom', description: 'Boom', inputSchema: {}, handler: async () => { throw new Error('nope'); } },
    ]);
    const res = await client.callTool({ name: 'boom', arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: 'text', text: 'error: nope' }]);
  });
});
```

- [ ] **Step 5: Run to verify failure, then implement `mcp-server.ts`**

```ts
// packages/daemon/src/computer/mcp-server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ComputerSession } from './session.js';
import { buildComputerTools, type ComputerTool } from './tools.js';

export function createComputerMcpServer(tools: ComputerTool[]): McpServer {
  const server = new McpServer({ name: 'remote-hands-computer', version: '0.1.0' });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: any) => {
        try {
          return { content: [{ type: 'text' as const, text: await tool.handler(args) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: 'text' as const, text: `error: ${err?.message ?? String(err)}` }] };
        }
      },
    );
  }
  return server;
}

export async function serveComputerMcp(session: ComputerSession): Promise<void> {
  const server = createComputerMcpServer(buildComputerTools(session));
  await server.connect(new StdioServerTransport());
}
```

Run: `npx vitest run packages/daemon/src/computer`. Expected: PASS. If `registerTool` is named differently in the installed SDK version, use the equivalent (`tool(name, description, schema, cb)`) and keep the tests as the contract.

- [ ] **Step 6: Write the failing CLI test**

```ts
// packages/cli/src/commands/mcp.test.ts
import { describe, it, expect, vi } from 'vitest';
import { mcpCommand } from './mcp.js';

describe('mcpCommand', () => {
  it('install registers the stdio server with agy using this node and cli path', async () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const stdout = vi.fn();
    const code = await mcpCommand(['install'], {
      exec,
      stdout,
      nodePath: '/usr/bin/node',
      cliPath: '/opt/rh/index.js',
    });
    expect(code).toBe(0);
    expect(exec).toHaveBeenCalledWith('agy', [
      'mcp', 'add', 'rh-computer', '--', '/usr/bin/node', '/opt/rh/index.js', 'mcp', 'serve',
    ]);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('rh-computer'));
  });

  it('install surfaces agy failures', async () => {
    const exec = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'agy exploded' });
    const stderr = vi.fn();
    const code = await mcpCommand(['install'], { exec, stderr, nodePath: 'n', cliPath: 'c' });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('agy exploded'));
  });

  it('remove unregisters the server', async () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });
    expect(await mcpCommand(['remove'], { exec, stdout: vi.fn() })).toBe(0);
    expect(exec).toHaveBeenCalledWith('agy', ['mcp', 'remove', 'rh-computer']);
  });

  it('serve starts the server and returns when it ends', async () => {
    const serve = vi.fn().mockResolvedValue(undefined);
    expect(await mcpCommand(['serve'], { serve })).toBe(0);
    expect(serve).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown subcommands', async () => {
    const stderr = vi.fn();
    expect(await mcpCommand(['wat'], { stderr })).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Usage: rh mcp'));
  });
});
```

- [ ] **Step 7: Run to verify failure, then implement `mcp.ts` and route it**

```ts
// packages/cli/src/commands/mcp.ts
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createDefaultComputerSession, serveComputerMcp } from '@remote-hands/daemon';
import type { CommandContext } from './setup.js';

export const AGY_MCP_NAME = 'rh-computer';

type ExecResult = { status: number | null; stdout: string; stderr: string };

export interface McpCommandContext extends CommandContext {
  exec?: (command: string, args: string[]) => ExecResult;
  serve?: () => Promise<void>;
  nodePath?: string;
  cliPath?: string;
}

const realExec = (command: string, args: string[]): ExecResult => {
  const res = spawnSync(command, args, { encoding: 'utf-8' });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
};

function currentCliPath(): string {
  const entry = process.argv[1];
  if (!entry) throw new Error('Cannot determine rh entry path');
  return realpathSync(entry);
}

export async function mcpCommand(args: string[], context: McpCommandContext = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const stderr = context.stderr ?? console.error;
  const exec = context.exec ?? realExec;
  const sub = args[0] ?? 'serve';

  if (sub === 'serve') {
    const serve = context.serve ?? (() => serveComputerMcp(createDefaultComputerSession()));
    await serve();
    return 0;
  }

  if (sub === 'install') {
    const res = exec('agy', [
      'mcp', 'add', AGY_MCP_NAME, '--',
      context.nodePath ?? process.execPath,
      context.cliPath ?? currentCliPath(),
      'mcp', 'serve',
    ]);
    if (res.status !== 0) {
      stderr(`Failed to register ${AGY_MCP_NAME} with agy: ${res.stderr.trim() || res.stdout.trim()}`);
      return 1;
    }
    stdout(`Registered MCP server ${AGY_MCP_NAME} with agy.`);
    return 0;
  }

  if (sub === 'remove') {
    const res = exec('agy', ['mcp', 'remove', AGY_MCP_NAME]);
    if (res.status !== 0) {
      stderr(`Failed to remove ${AGY_MCP_NAME}: ${res.stderr.trim() || res.stdout.trim()}`);
      return 1;
    }
    stdout(`Removed MCP server ${AGY_MCP_NAME}.`);
    return 0;
  }

  stderr('Usage: rh mcp <serve|install|remove>');
  return 1;
}
```

In `packages/cli/src/index.ts`: add `import { mcpCommand } from './commands/mcp.js';`, add `mcpCommand` to the export list, add the help line `stdout('  mcp         Run or register the warm computer-use MCP server for agy');`, and route:

```ts
  if (command === 'mcp') {
    return await mcpCommand(args, context);
  }
```

Add to `packages/daemon/src/index.ts`:

```ts
export * from './computer/tools.js';
export * from './computer/mcp-server.js';
```

Run: `npx vitest run packages/cli/src/commands/mcp.test.ts packages/cli/src/cli.test.ts`
Expected: PASS (update `cli.test.ts` help snapshot only if it asserts the full command list).

- [ ] **Step 8: Verify the real server over stdio**

Run: `npm run build`, then:

```bash
printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' | (cat; sleep 1) | node packages/cli/dist/index.js mcp serve | head -c 600
```

Expected: one JSON line containing `"serverInfo":{"name":"remote-hands-computer"`. No other text on stdout.

- [ ] **Step 9: Commit**

```bash
git add packages/daemon packages/cli/src package-lock.json
git commit -m "feat(mcp): warm computer-use MCP server and rh mcp command" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Warm `agy` session, slim prompt, HUD wiring

**Files:**
- Create: `packages/daemon/src/warm-agy-session.ts`
- Create: `packages/daemon/src/warm-agy-session.test.ts`
- Create: `packages/daemon/src/computer/prompt.ts`
- Modify: `packages/daemon/src/agy-runner.ts` (constructor, `run`, new `prewarm`, new `runWarm`)
- Modify: `packages/daemon/src/guidance/hud-coordinator.ts:397` and `startListening()` (~line 600) / stop path
- Modify: `packages/daemon/src/index.ts` (exports)
- Test: `packages/daemon/src/agy-runner.test.ts` (extend)

**Interfaces:**
- Consumes: `parseAgyStreamLine(line): EventInput | null` and `EventInput` (`{ kind, payload }`), `AgentRunResult`.
- Produces:
  - `interface WarmSessionConfig { model: string; effort?: string | undefined; workspace?: string | undefined; mode?: string | undefined }`
  - `interface TurnResult { events: EventInput[]; summary: string; conversationId: string | null; failed: boolean; aborted: boolean }`
  - `class WarmAgySession` with `prewarm(config)`, `runTurn(prompt, config, onEvent?, signal?): Promise<TurnResult>`, `hasHistory(): boolean`, `reset(): void` (kill and forget the conversation), `stop(): void`
  - `buildWarmAgyArgs(config: WarmSessionConfig & { conversationId?: string | null }): string[]`
  - `SLIM_COMPUTER_PROMPT: string`
  - `ProcessAgentRunner` constructor gains a 4th optional parameter `warmSession?: WarmAgySession`, plus `prewarm(): void`, `newConversation(): void` (reset then prewarm) and `stop(): void`.

Verified manually on 2026-10-03: `printf '{"event":"user","message":{"content":"..."}}\n' | agy --input-format stream-json --output-format stream-json --print-timeout 0 --model gemini-3.8-flash --effort low -p=` accepts several user lines, keeps one `conversation_id`, and emits one `{"event":"result",...}` per turn. The prompt must be sent as `{"event":"user","message":{"content":"<text>"}}`.

- [ ] **Step 1: Write the failing tests with a fake `agy` process**

```ts
// packages/daemon/src/warm-agy-session.test.ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WarmAgySession, buildWarmAgyArgs } from './warm-agy-session.js';
import type { EventInput } from './task-store.js';

class FakeProc extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 123;
  killed = false;
  written: string[] = [];
  constructor() {
    super();
    this.stdin.on('data', (c) => this.written.push(String(c)));
  }
  kill() {
    this.killed = true;
    this.emit('close', null);
    return true;
  }
  reply(response: string, conversationId = 'conv-1') {
    this.stdout.write(
      JSON.stringify({ event: 'result', result: { conversation_id: conversationId, status: 'SUCCESS', response } }) + '\n',
    );
  }
}

function parseLine(line: string): EventInput | null {
  const rec = JSON.parse(line);
  if (rec.event === 'result') {
    return { kind: 'result', payload: { summary: rec.result.response, conversation_id: rec.result.conversation_id } };
  }
  return { kind: 'agent_text', payload: { text: line } };
}

const config = { model: 'gemini-3.8-flash', effort: 'low' };

function makeSession() {
  const procs: FakeProc[] = [];
  const spawnFn = vi.fn((_cmd: string, _args: string[]) => {
    const p = new FakeProc();
    procs.push(p);
    return p as any;
  });
  const session = new WarmAgySession({ command: 'agy', parseLine, spawnFn: spawnFn as any });
  return { session, procs, spawnFn };
}

describe('buildWarmAgyArgs', () => {
  it('builds stream-json args with model, effort, workspace and conversation', () => {
    expect(
      buildWarmAgyArgs({ model: 'gemini-3.8-flash', effort: 'low', workspace: '/w', mode: 'plan', conversationId: 'c1' }),
    ).toEqual([
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '0',
      '--add-dir', '/w', '--conversation', 'c1', '--mode', 'plan',
      '--model', 'gemini-3.8-flash', '--effort', 'low', '-p=',
    ]);
  });

  it('omits effort for claude models', () => {
    expect(buildWarmAgyArgs({ model: 'claude-sonnet-4-6', effort: 'low' })).not.toContain('--effort');
  });
});

describe('WarmAgySession', () => {
  it('spawns once, sends a user event per turn and resolves on the result event', async () => {
    const { session, procs, spawnFn } = makeSession();
    const first = session.runTurn('hello', config);
    await Promise.resolve();
    procs[0]!.reply('one');
    const r1 = await first;
    expect(r1).toMatchObject({ summary: 'one', conversationId: 'conv-1', failed: false, aborted: false });
    const second = session.runTurn('again', config);
    await Promise.resolve();
    procs[0]!.reply('two');
    expect((await second).summary).toBe('two');
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(procs[0]!.written.join('')).toBe(
      '{"event":"user","message":{"content":"hello"}}\n{"event":"user","message":{"content":"again"}}\n',
    );
    expect(session.hasHistory()).toBe(true);
  });

  it('forwards events to onEvent in order', async () => {
    const { session, procs } = makeSession();
    const seen: string[] = [];
    const turn = session.runTurn('x', config, (e) => { seen.push(e.kind); });
    await Promise.resolve();
    procs[0]!.stdout.write('{"event":"step_update"}\n');
    procs[0]!.reply('done');
    await turn;
    expect(seen).toEqual(['agent_text', 'result']);
  });

  it('reset kills the process and starts the next turn without --conversation', async () => {
    const { session, procs, spawnFn } = makeSession();
    const t1 = session.runTurn('a', config);
    await Promise.resolve();
    procs[0]!.reply('A', 'conv-5');
    await t1;
    session.reset();
    expect(procs[0]!.killed).toBe(true);
    expect(session.hasHistory()).toBe(false);
    const t2 = session.runTurn('b', config);
    await Promise.resolve();
    expect(spawnFn.mock.calls[1]![1]).not.toContain('--conversation');
    procs[1]!.reply('B', 'conv-6');
    await t2;
  });

  it('prewarm spawns without sending anything', () => {
    const { session, procs, spawnFn } = makeSession();
    session.prewarm(config);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(procs[0]!.written).toEqual([]);
  });

  it('restarts with --conversation when the process died between turns', async () => {
    const { session, procs, spawnFn } = makeSession();
    const t1 = session.runTurn('a', config);
    await Promise.resolve();
    procs[0]!.reply('A', 'conv-9');
    await t1;
    procs[0]!.emit('close', 1);
    const t2 = session.runTurn('b', config);
    await Promise.resolve();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(spawnFn.mock.calls[1]![1]).toEqual(expect.arrayContaining(['--conversation', 'conv-9']));
    procs[1]!.reply('B', 'conv-9');
    expect((await t2).summary).toBe('B');
  });

  it('restarts when model or effort changes', async () => {
    const { session, procs, spawnFn } = makeSession();
    const t1 = session.runTurn('a', config);
    await Promise.resolve();
    procs[0]!.reply('A');
    await t1;
    const t2 = session.runTurn('b', { model: 'gemini-3.1-pro-high', effort: 'high' });
    await Promise.resolve();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(procs[0]!.killed).toBe(true);
    procs[1]!.reply('B');
    await t2;
  });

  it('abort kills the process, resolves aborted, and the next turn respawns', async () => {
    const { session, procs, spawnFn } = makeSession();
    const ctrl = new AbortController();
    const t1 = session.runTurn('a', config, undefined, ctrl.signal);
    await Promise.resolve();
    ctrl.abort();
    const r1 = await t1;
    expect(r1.aborted).toBe(true);
    expect(procs[0]!.killed).toBe(true);
    const t2 = session.runTurn('b', config);
    await Promise.resolve();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    procs[1]!.reply('B');
    expect((await t2).summary).toBe('B');
  });

  it('resolves failed when the process dies mid-turn', async () => {
    const { session, procs } = makeSession();
    const t = session.runTurn('a', config);
    await Promise.resolve();
    procs[0]!.emit('close', 1);
    expect(await t).toMatchObject({ failed: true, aborted: false });
  });

  it('serializes overlapping turns', async () => {
    const { session, procs } = makeSession();
    const t1 = session.runTurn('a', config);
    const t2 = session.runTurn('b', config);
    await Promise.resolve();
    expect(procs[0]!.written.join('')).toBe('{"event":"user","message":{"content":"a"}}\n');
    procs[0]!.reply('A');
    await t1;
    await Promise.resolve();
    await Promise.resolve();
    expect(procs[0]!.written.join('')).toContain('"content":"b"');
    procs[0]!.reply('B');
    expect((await t2).summary).toBe('B');
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement `warm-agy-session.ts`**

Run: `npx vitest run packages/daemon/src/warm-agy-session.test.ts` (FAIL). Then:

```ts
// packages/daemon/src/warm-agy-session.ts
import { spawn, type ChildProcess } from 'node:child_process';
import type { EventInput } from './task-store.js';

export interface WarmSessionConfig {
  model: string;
  effort?: string | undefined;
  workspace?: string | undefined;
  mode?: string | undefined;
}

export interface TurnResult {
  events: EventInput[];
  summary: string;
  conversationId: string | null;
  failed: boolean;
  aborted: boolean;
}

export interface WarmAgySessionOptions {
  command: string;
  parseLine: (line: string) => EventInput | null;
  spawnFn?: typeof spawn;
  env?: NodeJS.ProcessEnv;
}

export function buildWarmAgyArgs(c: WarmSessionConfig & { conversationId?: string | null }): string[] {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '0'];
  if (c.workspace) args.push('--add-dir', c.workspace);
  if (c.conversationId) args.push('--conversation', c.conversationId);
  if (c.mode && c.mode !== 'default') args.push('--mode', c.mode);
  if (c.model) args.push('--model', c.model);
  if (c.effort && !c.model.toLowerCase().includes('claude')) args.push('--effort', c.effort);
  args.push('-p=');
  return args;
}

interface ActiveTurn {
  events: EventInput[];
  summary: string;
  conversationId: string | null;
  onEvent: ((event: EventInput) => Promise<void> | void) | undefined;
  chain: Promise<void>;
  finish: (partial: Partial<TurnResult>) => void;
}

export class WarmAgySession {
  private proc: ChildProcess | null = null;
  private procKey = '';
  private buffer = '';
  private turn: ActiveTurn | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lastConversationId: string | null = null;

  constructor(private readonly opts: WarmAgySessionOptions) {}

  hasHistory(): boolean {
    return this.lastConversationId !== null;
  }

  prewarm(config: WarmSessionConfig): void {
    try {
      this.ensure(config);
    } catch {}
  }

  stop(): void {
    this.kill();
  }

  reset(): void {
    this.kill();
    this.lastConversationId = null;
  }

  runTurn(
    prompt: string,
    config: WarmSessionConfig,
    onEvent?: (event: EventInput) => Promise<void> | void,
    signal?: AbortSignal,
  ): Promise<TurnResult> {
    const run = () =>
      new Promise<TurnResult>((resolve) => {
        const cancelled = (): TurnResult => ({
          events: [],
          summary: 'Task cancelled by user',
          conversationId: this.lastConversationId,
          failed: false,
          aborted: true,
        });
        if (signal?.aborted) return resolve(cancelled());

        let proc: ChildProcess;
        try {
          proc = this.ensure(config);
        } catch (err: any) {
          return resolve({
            events: [],
            summary: err?.message ?? 'Failed to start agy',
            conversationId: this.lastConversationId,
            failed: true,
            aborted: false,
          });
        }

        let onAbort: (() => void) | undefined;
        const turn: ActiveTurn = {
          events: [],
          summary: '',
          conversationId: this.lastConversationId,
          onEvent,
          chain: Promise.resolve(),
          finish: (partial) => {
            if (this.turn !== turn) return;
            this.turn = null;
            if (onAbort) signal?.removeEventListener('abort', onAbort);
            void turn.chain.then(() =>
              resolve({
                events: turn.events,
                summary: turn.summary,
                conversationId: turn.conversationId,
                failed: false,
                aborted: false,
                ...partial,
              }),
            );
          },
        };
        this.turn = turn;

        if (signal) {
          onAbort = () => {
            this.kill();
            turn.finish({ summary: 'Task cancelled by user', aborted: true });
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }

        proc.stdin?.write(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
      });

    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private ensure(config: WarmSessionConfig): ChildProcess {
    const key = JSON.stringify([config.model, config.effort ?? '', config.mode ?? '']);
    if (this.proc && this.procKey === key) return this.proc;
    if (this.proc) this.kill();

    const spawnFn = this.opts.spawnFn ?? spawn;
    const proc = spawnFn(
      this.opts.command,
      buildWarmAgyArgs({ ...config, conversationId: this.lastConversationId }),
      {
        cwd: config.workspace || process.cwd(),
        env: {
          ...(this.opts.env ?? process.env),
          BU_CDP_URL: process.env.BU_CDP_URL || 'http://127.0.0.1:9222',
          CHROME_REMOTE_DEBUGGING_PORT: process.env.CHROME_REMOTE_DEBUGGING_PORT || '9222',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.proc = proc;
    this.procKey = key;
    this.buffer = '';

    proc.stdout?.on('data', (chunk: Buffer) => this.onData(proc, chunk.toString()));
    proc.stderr?.on('data', () => {});
    proc.on('error', () => this.onClose(proc));
    proc.on('close', () => this.onClose(proc));
    return proc;
  }

  private onData(proc: ChildProcess, text: string): void {
    if (proc !== this.proc) return;
    this.buffer += text;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const event = this.opts.parseLine(line);
      const turn = this.turn;
      if (!event || !turn) continue;
      turn.events.push(event);
      const conversationId = (event.payload as any)?.conversation_id;
      if (typeof conversationId === 'string') {
        turn.conversationId = conversationId;
        this.lastConversationId = conversationId;
      }
      if (turn.onEvent) {
        const handler = turn.onEvent;
        turn.chain = turn.chain.then(async () => {
          try {
            await handler(event);
          } catch {}
        });
      }
      if (event.kind === 'result') {
        turn.summary = (event.payload as any)?.summary ?? turn.summary;
        turn.finish({});
      }
    }
  }

  private onClose(proc: ChildProcess): void {
    if (proc !== this.proc) return;
    this.proc = null;
    this.procKey = '';
    this.turn?.finish({ summary: 'agy process exited unexpectedly', failed: true });
  }

  private kill(): void {
    const proc = this.proc;
    this.proc = null;
    this.procKey = '';
    if (!proc) return;
    try {
      proc.kill('SIGTERM');
    } catch {}
  }
}
```

Run: `npx vitest run packages/daemon/src/warm-agy-session.test.ts`
Expected: PASS (9 tests). If the "serializes overlapping turns" timing is off by a microtask, add one more `await Promise.resolve()` in the test, not a `setTimeout`.

- [ ] **Step 3: Add the slim prompt**

```ts
// packages/daemon/src/computer/prompt.ts
export const SLIM_COMPUTER_PROMPT = [
  '[Context: Remote Hands computer use. You operate the user\'s Mac and signed-in Chrome directly. Act immediately; never run discovery commands.',
  'Tools (MCP server rh-computer): desktop_snapshot, desktop_click, desktop_type, desktop_key, desktop_open, desktop_menu, desktop_windows, browser_tabs, browser_focus, browser_open, browser_snapshot, browser_click, browser_type, computer_batch.',
  'Rules:',
  '1. Every action tool returns the new UI state. Do not call a snapshot after an action unless you need a filtered view. Indexes come from the latest state only.',
  '2. Reuse the active window, profile and tab. Use browser_tabs/browser_focus before browser_open. Never switch profiles or open duplicate tabs.',
  '3. No screenshots, no ad-hoc Swift/Python/CGEvent/pyautogui scripts, no remote-debugging scripts, no physical mouse movement.',
  '4. Finish multi-step tasks (surveys, forms, flows) end to end without asking the user to confirm intermediate steps. Do not re-toggle controls that are already [checked].',
  '5. For "how do I / where is / show me" requests, do not click: point with `rh guide show --browser --index=<i> --text="<label>"` or `rh guide show --desktop --app="<app>" --target="<target>" --text="<label>"`.',
  '6. Before sensitive or irreversible actions (post, send, delete, deploy, pay) run `rh approve "<exact action>" --action=<publish|delete|push|pay|send> --risk=high` and proceed only on exit code 0. On rejection read stderr, adjust, and re-request or cancel. After [HUMAN APPROVAL GRANTED] act immediately.',
  '7. You also have full terminal and filesystem access for code and file tasks. Go directly to the relevant files; run targeted tests only.',
  '8. Finish with a short markdown summary of what was done.]',
].join('\n');
```

- [ ] **Step 4: Write the failing runner tests**

Append to `packages/daemon/src/agy-runner.test.ts`:

```ts
import { WarmAgySession } from './warm-agy-session.js';

describe('ProcessAgentRunner with a warm session', () => {
  const baseTask = {
    id: 't1',
    prompt: 'open Slack',
    workspace_path: null,
    conversation_id: null,
    model: null,
    effort: null,
    mode: null,
  } as any;

  it('uses the warm session instead of spawning, sending the system prompt only on the first turn', async () => {
    const prompts: string[] = [];
    const session = {
      hasHistory: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
      runTurn: vi.fn(async (prompt: string, _cfg: any, onEvent?: any) => {
        prompts.push(prompt);
        await onEvent?.({ kind: 'agent_text', payload: { text: 'hi' } });
        return { events: [{ kind: 'agent_text', payload: { text: 'hi' } }], summary: 'done', conversationId: 'c1', failed: false, aborted: false };
      }),
      prewarm: vi.fn(),
    } as unknown as WarmAgySession;
    const brain = {
      prepareTaskContext: vi.fn(async (t: any) => ({ augmentedPrompt: t.prompt, resolvedWorkspacePath: null, recommendedEffort: 'low' })),
      recordTaskCompletion: vi.fn(),
    } as any;
    const runner = new ProcessAgentRunner('agy', 'SYSTEM', brain, session);
    const events: string[] = [];
    const r1 = await runner.run(baseTask, (e) => { events.push(e.kind); });
    const r2 = await runner.run({ ...baseTask, prompt: 'then open Mail' });
    expect(prompts[0]).toBe('SYSTEM\n\nopen Slack');
    expect(prompts[1]).toBe('then open Mail');
    expect(r1).toMatchObject({ summary: 'done', conversationId: 'c1', status: 'done' });
    expect(r2.status).toBe('done');
    expect(events).toEqual(['agent_text']);
  });

  it('maps failed and aborted turns to the runner result', async () => {
    const make = (turn: any) =>
      new ProcessAgentRunner('agy', 'S', { prepareTaskContext: async (t: any) => ({ augmentedPrompt: t.prompt }), recordTaskCompletion: vi.fn() } as any, {
        hasHistory: () => true,
        runTurn: async () => turn,
        prewarm: vi.fn(),
      } as any);
    const failed = await make({ events: [], summary: 'agy process exited unexpectedly', conversationId: null, failed: true, aborted: false }).run(baseTask);
    expect(failed).toMatchObject({ status: 'failed', summary: 'agy process exited unexpectedly' });
    const aborted = await make({ events: [], summary: 'Task cancelled by user', conversationId: null, failed: false, aborted: true }).run(baseTask);
    expect(aborted).toMatchObject({ status: 'done', summary: 'Task cancelled by user' });
  });

  it('starts a fresh conversation when a new task carries no conversation_id but the session has history', async () => {
    const reset = vi.fn();
    const runner = new ProcessAgentRunner('agy', 'SYSTEM', { prepareTaskContext: async (t: any) => ({ augmentedPrompt: t.prompt }), recordTaskCompletion: vi.fn() } as any, {
      hasHistory: () => true,
      reset,
      runTurn: async () => ({ events: [], summary: 'ok', conversationId: 'c2', failed: false, aborted: false }),
      prewarm: vi.fn(),
    } as any);
    await runner.run({ ...baseTask, conversation_id: null });
    expect(reset).toHaveBeenCalledTimes(1);
    reset.mockClear();
    await runner.run({ ...baseTask, conversation_id: 'c2' });
    expect(reset).not.toHaveBeenCalled();
  });

  it('newConversation resets then prewarms', () => {
    const calls: string[] = [];
    const runner = new ProcessAgentRunner('agy', 'S', undefined, { reset: () => calls.push('reset'), prewarm: () => calls.push('prewarm') } as any);
    runner.newConversation();
    expect(calls).toEqual(['reset', 'prewarm']);
  });

  it('prewarm starts the session with the default model and effort', () => {
    const prewarm = vi.fn();
    new ProcessAgentRunner('agy', 'S', undefined, { prewarm } as any).prewarm();
    expect(prewarm).toHaveBeenCalledWith({ model: 'gemini-3.8-flash', effort: 'low' });
  });
});
```

(Ensure the file already imports `vi`, `describe`, `it`, `expect` and `ProcessAgentRunner`; add what is missing.)

- [ ] **Step 5: Run to verify failure, then wire `ProcessAgentRunner`**

Run: `npx vitest run packages/daemon/src/agy-runner.test.ts` (new tests FAIL). Then in `agy-runner.ts`:

1. Add `import type { WarmAgySession, WarmSessionConfig } from './warm-agy-session.js';`.
2. Add a field and constructor parameter:

```ts
  private warmSession?: WarmAgySession;

  constructor(agyCommand: string = 'agy', systemPrompt?: string, hermesBrain?: HermesBrain, warmSession?: WarmAgySession) {
    this.agyCommand = agyCommand;
    this.systemPrompt = systemPrompt ?? getDefaultRemoteHandsSystemPrompt();
    this.hermesBrain = hermesBrain ?? new HermesBrain();
    this.warmSession = warmSession;
  }

  prewarm(): void {
    this.warmSession?.prewarm({ model: 'gemini-3.8-flash', effort: 'low' });
  }

  newConversation(): void {
    this.warmSession?.reset();
    this.prewarm();
  }
```

3. In `run`, immediately after the existing block that rewrites `effectiveTask.model` (the `gemini-3.8-flash-high` + `low` mapping) and before `const args = buildAgyArgs(...)`, insert:

```ts
    if (this.warmSession) {
      return this.runWarm(task, effectiveTask, onEvent, signal);
    }
```

4. Add the method:

```ts
  private async runWarm(
    task: Task,
    effectiveTask: Task,
    onEvent?: (event: EventInput) => Promise<void> | void,
    signal?: AbortSignal,
  ): Promise<AgentRunResult> {
    const session = this.warmSession!;
    if (!task.conversation_id && session.hasHistory()) session.reset();
    const isFirst = !session.hasHistory();
    const prompt = isFirst ? `${this.systemPrompt}\n\n${effectiveTask.prompt}` : effectiveTask.prompt;
    const config: WarmSessionConfig = {
      model: effectiveTask.model || 'gemini-3.8-flash',
      effort: effectiveTask.effort || 'low',
      workspace: task.workspace_path || undefined,
      mode: task.mode && task.mode !== 'default' ? task.mode : undefined,
    };
    const turn = await session.runTurn(prompt, config, onEvent, signal);
    if (!turn.failed && !turn.aborted) {
      try {
        await this.hermesBrain.recordTaskCompletion({
          prompt: task.prompt,
          summary: turn.summary,
          workspacePath: task.workspace_path || undefined,
          conversationId: turn.conversationId,
        });
      } catch {}
    }
    return {
      events: turn.events,
      summary: turn.summary || (turn.failed ? 'Task failed' : 'Task completed'),
      conversationId: turn.conversationId,
      status: turn.failed ? 'failed' : 'done',
    };
  }
```

The effective model/effort are the same values `prewarm()` uses (`gemini-3.8-flash` / `low`), so the first real task reuses the prewarmed process; a task with a different model or effort restarts the process once, keeping context through `--conversation`.

Run: `npx vitest run packages/daemon/src/agy-runner.test.ts`. Expected: PASS, including every pre-existing test.

- [ ] **Step 6: Wire the HUD coordinator**

In `hud-coordinator.ts`:

- Imports: `import { WarmAgySession } from '../warm-agy-session.js';`, `import { SLIM_COMPUTER_PROMPT } from '../computer/prompt.js';`, and change the existing import to `import { ProcessAgentRunner, parseAgyStreamLine, type AgentRunner } from '../agy-runner.js';`.
- Add a private field `private defaultRunner?: ProcessAgentRunner;` and helper:

```ts
  private getRunner(): AgentRunner {
    if (this.runner) return this.runner;
    if (!this.defaultRunner) {
      const session = new WarmAgySession({ command: 'agy', parseLine: parseAgyStreamLine });
      this.defaultRunner = new ProcessAgentRunner('agy', SLIM_COMPUTER_PROMPT, undefined, session);
    }
    return this.defaultRunner;
  }
```

- Replace line 397 `const runner = this.runner || new ProcessAgentRunner('agy');` with `const runner = this.getRunner();`.
- In `startListening()`, before it returns, add `this.defaultRunner ?? this.getRunner();` guarded by `if (!this.runner)`, then `this.defaultRunner?.prewarm();`.
- At the two places that clear `this.currentConversationId = undefined` (in `cancelActiveTask`, line ~333, and in the hotkey branch of `startListening()`, line ~618) also call `this.defaultRunner?.newConversation();`. The user is still typing at that moment, so the respawn cold start is hidden. Without this the warm session would carry context from an unrelated earlier request into a new HUD session.
- Where the listener `stop` is built in `startListening()` (the object that calls `runnerListener.stop()`, near line 650) also call `this.defaultRunner?.stop()`. Add to `ProcessAgentRunner`:

```ts
  stop(): void {
    this.warmSession?.stop();
  }
```

Existing `hud-coordinator.test.ts` tests inject `runner`, so `getRunner()` returns it and they are unaffected. Add one test to `hud-coordinator.test.ts`: construct the coordinator with an injected `runner` and assert that `startListening()` does not spawn anything (spy on `child_process.spawn` via `vi.mock` or simply assert no throw and that the injected `run` is used on a task). Follow the file's existing construction pattern.

Run: `npx vitest run packages/daemon/src/guidance/hud-coordinator.test.ts packages/daemon/src/agy-runner.test.ts packages/daemon/src/warm-agy-session.test.ts`
Expected: PASS.

- [ ] **Step 7: Export and commit**

Add to `packages/daemon/src/index.ts`:

```ts
export * from './warm-agy-session.js';
export * from './computer/prompt.js';
```

```bash
git add packages/daemon
git commit -m "feat(hud): keep one warm agy session and slim system prompt" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Install, end-to-end check, after-numbers, docs

**Files:**
- Modify: `.agents/skills/remote-hands-operator/SKILL.md` (add MCP tool section)
- Modify: `docs/development.md` (add `rh mcp install` and benchmark notes)

**Interfaces:**
- Consumes: everything above.
- Produces: a working installed setup and recorded before/after numbers.

- [ ] **Step 1: Ask the user before touching their installed CLI**

`rh` resolves to `~/.remote-hands/cli/index.js`, a copied bundle that is not tracked by this repo. Ask the user for a go-ahead before overwriting it. After approval:

```bash
npm run build
cp ~/.remote-hands/cli/index.js /private/tmp/claude-501/-Users-kushal-Desktop-project-remote-hands/924b3783-7f50-4084-99cf-5c17e093c09b/scratchpad/rh-index.backup.js
cp packages/cli/dist/index.js ~/.remote-hands/cli/index.js
rh mcp install
agy mcp list
```

Expected: `rh-computer  stdio  enabled  ...` appears in the list. Roll back with the backup copy if anything misbehaves.

- [ ] **Step 2: Verify `agy` can call the tools**

Run:

```bash
agy -p "Call desktop_windows and reply with only the first line." --model gemini-3.8-flash --effort low --output-format stream-json 2>&1 | grep -E '"tool_name"|"response"' | head -5
```

Expected: a tool step naming `desktop_windows` (possibly via `call_mcp_tool`) and a response with an `App - Title` line. If the tool call is denied by permissions, run `rh permissions fix` (it sets `defaultAction: allow`) and retry. Do not add `--dangerously-skip-permissions`.

- [ ] **Step 3: Record the after-numbers**

Run: `node scripts/bench-actions.mjs 5 | tee /private/tmp/claude-501/-Users-kushal-Desktop-project-remote-hands/924b3783-7f50-4084-99cf-5c17e093c09b/scratchpad/bench-after.txt` (run once before to populate the Swift cache).
Expected: `rh desktop snapshot --no-ocr` median under 500 ms. Report before/after to the user. If the AX walk is still over 500 ms, record that as the trigger for the follow-up "persistent Swift AX helper" plan rather than expanding this one.

- [ ] **Step 4: Live HUD smoke test (manual, with the user)**

Start the HUD (`rh hud listen`), then type a two-step request such as "open Calculator and press 7 then 8". Watch the HUD status updates. Expected: first agent output within a few seconds, tool calls named `desktop_*`, and a second request in the same session starts without an `agy` cold-start delay. Report anything slower than expected with timestamps.

- [ ] **Step 5: Update the operator skill and dev docs**

In `.agents/skills/remote-hands-operator/SKILL.md`, add a short section "MCP tools" listing the `desktop_*`, `browser_*` and `computer_batch` tools, stating that each returns fresh state and that the `rh browser|desktop` shell commands remain available as fallback. In `docs/development.md`, add: how to run `node scripts/bench-actions.mjs`, `rh mcp install|remove|serve`, and the location of the Swift cache (`~/.remote-hands/swift-cache`, safe to delete).

- [ ] **Step 6: Final verification and commit**

Run once: `npm run build && npm run typecheck && npm test`
Expected: all green. Fix regressions before committing.

```bash
git add .agents docs scripts
git commit -m "docs: document MCP computer tools, swift cache and benchmark" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** cached Swift binaries (Task 2), warm MCP server and compact state (Tasks 3-4), warm `agy` session with slim prompt and prewarm (Task 5), benchmark and success criteria (Tasks 1 and 6), install path and permissions (Task 6). Non-goals (fast path, OSS engine swap, persistent AX helper) are intentionally not planned.

**Placeholder scan:** none; the only conditional steps are the explicit fallbacks in Task 2 Step 6 and Task 4 Step 5, which name the concrete action to take.

**Type consistency:** `ComputerSession` method names match `buildComputerTools` calls; `WarmSessionConfig` and `TurnResult` are used identically in `warm-agy-session.ts` and `agy-runner.ts`; prewarm config `{ model: 'gemini-3.8-flash', effort: 'low' }` matches the effective-task defaults in `runWarm`; `AGY_MCP_NAME` is `rh-computer` in the command, the tests and the docs.

**Known risks the executor must watch:** `String as CFString/CFTypeRef` bridging in hoisted templates (Task 2 integration test catches it); SDK `registerTool` signature drift (Task 4 Step 5); `WindowInfo` field names in `session.ts` (Task 3 Step 5).
