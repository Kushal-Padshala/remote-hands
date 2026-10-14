import { describe, expect, it, vi } from 'vitest';
import { beginCommandLineTools, hasCommandLineTools } from './xcode-tools.js';

const present = { run: () => ({ status: 0, stdout: '/Library/Developer/CommandLineTools\n' }), exists: () => true, platform: 'darwin' as const };

describe('Command Line Tools check', () => {
  it('is satisfied when the active developer directory holds swiftc', () => {
    const seen: string[] = [];
    expect(hasCommandLineTools({ ...present, exists: (f) => { seen.push(f); return true; } })).toBe(true);
    expect(seen[0]).toBe('/Library/Developer/CommandLineTools/usr/bin/swiftc');
  });

  it('also accepts a full Xcode, which keeps swiftc inside its toolchain', () => {
    const xcode = '/Applications/Xcode.app/Contents/Developer';
    const real = '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc';
    expect(hasCommandLineTools({ run: () => ({ status: 0, stdout: `${xcode}\n` }), exists: (f) => f === real, platform: 'darwin' })).toBe(true);
    expect(hasCommandLineTools({ run: () => ({ status: 0, stdout: `${xcode}\n` }), exists: () => false, platform: 'darwin' })).toBe(false);
  });

  it('is not satisfied when xcode-select has no directory, or the compiler is missing there', () => {
    expect(hasCommandLineTools({ run: () => ({ status: 2, stdout: '' }), platform: 'darwin' })).toBe(false);
    expect(hasCommandLineTools({ ...present, exists: () => false })).toBe(false);
    expect(hasCommandLineTools({ run: () => { throw new Error('boom'); }, platform: 'darwin' })).toBe(false);
  });

  it('is always satisfied away from macOS', () => {
    expect(hasCommandLineTools({ platform: 'win32', run: () => { throw new Error('never'); } })).toBe(true);
  });
});

describe('beginCommandLineTools', () => {
  it('does nothing and says nothing when the tools exist', async () => {
    const run = vi.fn(present.run);
    const out: string[] = [];
    const handle = beginCommandLineTools({ ...present, run, stdout: (m) => out.push(m) });
    expect(await handle.wait()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(out).toEqual([]);
  });

  it('starts the macOS install once, explains it, and returns before it finishes', async () => {
    let installed = false;
    const calls: string[] = [];
    const out: string[] = [];
    const handle = beginCommandLineTools({
      platform: 'darwin',
      run: (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        return installed ? { status: 0, stdout: '/Library/Developer/CommandLineTools' } : { status: 2, stdout: '' };
      },
      exists: () => installed,
      sleep: async () => {},
      stdout: (m) => out.push(m),
    });
    expect(calls.filter((c) => c === 'xcode-select --install')).toHaveLength(1);
    expect(out.join('\n')).toContain('Command Line Tools');
    expect(out.join('\n')).toContain('5 to 15 minutes');
    // the person finishes the install while setup carries on
    installed = true;
    expect(await handle.wait()).toBe(true);
    expect(calls.filter((c) => c === 'xcode-select --install')).toHaveLength(1);
  });

  it('waits until the install completes', async () => {
    let polls = 0;
    const handle = beginCommandLineTools({
      platform: 'darwin',
      run: (_c, args) => (args[0] === '-p' && polls >= 3 ? { status: 0, stdout: '/x' } : { status: 2, stdout: '' }),
      exists: () => polls >= 3,
      sleep: async () => {
        polls += 1;
      },
      stdout: () => {},
    });
    expect(await handle.wait()).toBe(true);
    expect(polls).toBe(3);
  });

  it('gives up after the time limit and says so by returning false', async () => {
    const handle = beginCommandLineTools({
      platform: 'darwin',
      run: () => ({ status: 2, stdout: '' }),
      sleep: async () => {},
      timeoutMs: 20,
      intervalMs: 5,
      stdout: () => {},
    });
    expect(await handle.wait()).toBe(false);
  });

  it('still waits when starting the install throws (a window may already be open)', async () => {
    let done = false;
    const handle = beginCommandLineTools({
      platform: 'darwin',
      run: (_c, args) => {
        if (args[0] === '--install') throw new Error('already requested');
        return done ? { status: 0, stdout: '/x' } : { status: 2, stdout: '' };
      },
      exists: () => done,
      sleep: async () => {
        done = true;
      },
      stdout: () => {},
    });
    expect(await handle.wait()).toBe(true);
  });
});
