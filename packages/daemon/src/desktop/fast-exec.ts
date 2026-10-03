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
  if (duplicate || Object.keys(env).length === 0) return { template: script, env: {}, hoisted: false };
  return { template: SWIFT_PRELUDE + body, env, hoisted: true };
}

export function defaultSwiftCacheDir(): string {
  const override = process.env.RH_SWIFT_CACHE_DIR;
  if (override) return override;
  return path.join(os.homedir(), '.remote-hands', 'swift-cache');
}

export interface FastExecOptions {
  cacheDir?: string;
  spawn?: SpawnFn;
}

export function createFastExec(options: FastExecOptions = {}): ExecFunction {
  const run = options.spawn ?? realSpawn;

  return (command, args) => {
    const cacheDir = options.cacheDir ?? defaultSwiftCacheDir();
    if (command !== 'swift' || args[0] !== '-e' || typeof args[1] !== 'string') {
      return run(command, args);
    }
    const script = args[1];
    const extraArgs = args.slice(2);
    const { template, env, hoisted } = hoistSwiftParams(script);
    const hash = createHash('sha256').update(template).digest('hex').slice(0, 24);
    const dir = path.join(cacheDir, hash);
    const bin = path.join(dir, 'bin');
    try {
      if (!fs.existsSync(bin)) {
        fs.mkdirSync(dir, { recursive: true });
        const failedMarker = path.join(dir, 'failed');
        if (fs.existsSync(failedMarker)) return run(command, args);
        // A script without hoistable parameters may embed per-call values (coordinates,
        // typed text) directly in its body, so each call can be a brand-new template.
        // Only pay for compilation once the same template has been seen before.
        if (!hoisted) {
          const seenMarker = path.join(dir, 'seen');
          if (!fs.existsSync(seenMarker)) {
            fs.writeFileSync(seenMarker, '');
            return run(command, args);
          }
        }
        const buildDir = path.join(dir, `build-${process.pid}`);
        fs.mkdirSync(buildDir, { recursive: true });
        const source = path.join(buildDir, 'main.swift');
        fs.writeFileSync(source, template);
        const tmpBin = path.join(buildDir, 'bin');
        const compiled = run('swiftc', ['-O', source, '-o', tmpBin]);
        if (compiled.status !== 0 || !fs.existsSync(tmpBin)) {
          fs.rmSync(buildDir, { recursive: true, force: true });
          fs.writeFileSync(failedMarker, compiled.stderr);
          return run(command, args);
        }
        fs.renameSync(tmpBin, bin);
        fs.rmSync(buildDir, { recursive: true, force: true });
      }
    } catch {
      return run(command, args);
    }
    return run(bin, extraArgs, env);
  };
}

export const fastExec: ExecFunction = createFastExec();
