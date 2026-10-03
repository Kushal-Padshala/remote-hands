import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hoistSwiftParams, createFastExec, defaultSwiftCacheDir, type SpawnFn } from './fast-exec.js';

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

  it('forwards arguments after the script to the compiled binary', () => {
    const { spawn, calls } = makeSpawn();
    const exec = createFastExec({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')), spawn });
    exec('swift', ['-e', 'let query = "A"\nprint(CommandLine.arguments)\n', '/tmp/out.jpg', '1280']);
    const run = calls.find((c) => c.command !== 'swiftc')!;
    expect(run.args).toEqual(['/tmp/out.jpg', '1280']);
    expect(run.env).toEqual({ RH_P_query: 'A' });
  });

  it('only compiles a parameterless script once it has been seen before', () => {
    const { spawn, calls } = makeSpawn();
    const exec = createFastExec({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')), spawn });
    const script = 'import Cocoa\nprint("windows")\n';
    exec('swift', ['-e', script]);
    expect(calls.map((c) => c.command)).toEqual(['swift']);
    exec('swift', ['-e', script]);
    exec('swift', ['-e', script]);
    const commands = calls.map((c) => c.command);
    expect(commands.filter((c) => c === 'swiftc')).toHaveLength(1);
    expect(commands.slice(1, 2)).toEqual(['swiftc']);
    expect(commands.filter((c) => c.endsWith('/bin'))).toHaveLength(2);
  });

  it('keeps the original script untouched when it falls back', () => {
    const seen: Array<{ command: string; args: string[] }> = [];
    const spawn: SpawnFn = (command, args) => {
      seen.push({ command, args });
      if (command === 'swiftc') return { stdout: '', stderr: 'boom', status: 1 };
      return { stdout: '', stderr: '', status: 0 };
    };
    const exec = createFastExec({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')), spawn });
    exec('swift', ['-e', 'let query = "A"\n', 'extra']);
    expect(seen[1]).toEqual({ command: 'swift', args: ['-e', 'let query = "A"\n', 'extra'] });
  });

  it('does not retry a compilation that already failed for the same template', () => {
    const calls: string[] = [];
    const spawn: SpawnFn = (command) => {
      calls.push(command);
      if (command === 'swiftc') return { stdout: '', stderr: 'boom', status: 1 };
      return { stdout: 'fallback', stderr: '', status: 0 };
    };
    const exec = createFastExec({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')), spawn });
    exec('swift', ['-e', 'let query = "A"\n']);
    exec('swift', ['-e', 'let query = "B"\n']);
    expect(calls).toEqual(['swiftc', 'swift', 'swift']);
  });
});

describe('defaultSwiftCacheDir', () => {
  it('honours RH_SWIFT_CACHE_DIR so tests never write into the real home cache', () => {
    const previous = process.env.RH_SWIFT_CACHE_DIR;
    try {
      process.env.RH_SWIFT_CACHE_DIR = '/tmp/rh-swift-cache-test';
      expect(defaultSwiftCacheDir()).toBe('/tmp/rh-swift-cache-test');
      delete process.env.RH_SWIFT_CACHE_DIR;
      expect(defaultSwiftCacheDir()).toBe(path.join(os.homedir(), '.remote-hands', 'swift-cache'));
    } finally {
      if (previous === undefined) delete process.env.RH_SWIFT_CACHE_DIR;
      else process.env.RH_SWIFT_CACHE_DIR = previous;
    }
  });

  it('resolves the cache directory per call, not once at creation', () => {
    const previous = process.env.RH_SWIFT_CACHE_DIR;
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-env-'));
    try {
      const exec = createFastExec({ spawn: (command, args) => {
        if (command === 'swiftc') fs.writeFileSync(args[args.indexOf('-o') + 1]!, '');
        return { stdout: '', stderr: '', status: 0 };
      } });
      process.env.RH_SWIFT_CACHE_DIR = cacheDir;
      exec('swift', ['-e', 'let query = "A"\n']);
      expect(fs.readdirSync(cacheDir)).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.RH_SWIFT_CACHE_DIR;
      else process.env.RH_SWIFT_CACHE_DIR = previous;
    }
  });
});
