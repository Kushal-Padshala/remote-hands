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

// Hoisted lines become `= rhStr(...)`, so any line still matching this after the replace was rejected.
const STRING_PARAM_START = /^(let|var) [A-Za-z_]\w* = "/m;

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
  // A top-level string parameter line that PARAM_LINE rejected (a raw newline, an unsupported
  // escape, ...) would stay inline while the rest is hoisted: the template would not compile and
  // per-call text would key a new cache entry. Run such a script unmodified via `swift -e`.
  const unhoistedStringParam = STRING_PARAM_START.test(body);
  if (duplicate || unhoistedStringParam || Object.keys(env).length === 0) {
    return { template: script, env: {}, hoisted: false };
  }
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
  /** Clock used for failure-marker expiry; injectable for tests. */
  now?: () => number;
}

/** A genuine compile diagnostic disables caching for a template only this long. */
export const COMPILE_FAILURE_TTL_MS = 10 * 60_000;

function failureIsFresh(marker: string, now: number): boolean {
  try {
    const at = Number((JSON.parse(fs.readFileSync(marker, 'utf-8')) as { at?: unknown }).at);
    if (Number.isFinite(at) && now - at < COMPILE_FAILURE_TTL_MS) return true;
  } catch {
    // unreadable or legacy marker: treat as expired
  }
  fs.rmSync(marker, { force: true });
  return false;
}

export function createFastExec(options: FastExecOptions = {}): ExecFunction {
  const run = options.spawn ?? realSpawn;
  const now = options.now ?? Date.now;

  return (command, args) => {
    const cacheDir = options.cacheDir ?? defaultSwiftCacheDir();
    if (command !== 'swift' || args[0] !== '-e' || typeof args[1] !== 'string') {
      return run(command, args);
    }
    const script = args[1];
    const extraArgs = args.slice(2);
    const { template, env, hoisted } = hoistSwiftParams(script);
    // Only scripts whose per-call values were hoisted into env vars are cached. A
    // script that was not hoisted may embed per-call data in its body (coordinates,
    // key codes, typed text such as passwords), so it must never be written to disk.
    if (!hoisted) return run(command, args);
    const hash = createHash('sha256').update(template).digest('hex').slice(0, 24);
    const dir = path.join(cacheDir, hash);
    const bin = path.join(dir, 'bin');
    try {
      if (!fs.existsSync(bin)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(cacheDir, 0o700);
        fs.chmodSync(dir, 0o700);
        const failedMarker = path.join(dir, 'failed');
        if (fs.existsSync(failedMarker) && failureIsFresh(failedMarker, now())) return run(command, args);
        const buildDir = path.join(dir, `build-${process.pid}`);
        fs.mkdirSync(buildDir, { recursive: true, mode: 0o700 });
        const source = path.join(buildDir, 'main.swift');
        fs.writeFileSync(source, template);
        const tmpBin = path.join(buildDir, 'bin');
        const compiled = run('swiftc', ['-O', source, '-o', tmpBin]);
        if (compiled.status !== 0 || !fs.existsSync(tmpBin)) {
          fs.rmSync(buildDir, { recursive: true, force: true });
          // Only a real compiler diagnostic is remembered (and only for a while). A
          // null status means swiftc could not run or was killed: retry next call.
          if (typeof compiled.status === 'number' && compiled.status !== 0) {
            // swiftc diagnostics quote source lines, so only the status and time are kept.
            fs.writeFileSync(failedMarker, JSON.stringify({ at: now(), status: compiled.status }));
          }
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
