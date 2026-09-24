import { describe, expect, it, vi } from 'vitest';
import { DynamicPowerManager } from './power-manager.js';

describe('DynamicPowerManager', () => {
  it('does not spawn wake assertion on non-darwin platforms', () => {
    const fakeSpawn = vi.fn();
    const mgr = new DynamicPowerManager({
      platform: 'linux',
      spawnFn: fakeSpawn as any,
    });

    mgr.startTask();
    expect(mgr.getActiveTaskCount()).toBe(1);
    expect(mgr.isAsserting()).toBe(false);
    expect(fakeSpawn).not.toHaveBeenCalled();

    mgr.endTask();
    expect(mgr.getActiveTaskCount()).toBe(0);
  });

  it('spawns caffeinate -i -s on darwin when task starts and kills on end', () => {
    const fakeProc = {
      kill: vi.fn(),
      unref: vi.fn(),
    };
    const fakeSpawn = vi.fn().mockReturnValue(fakeProc);
    const mgr = new DynamicPowerManager({
      platform: 'darwin',
      spawnFn: fakeSpawn as any,
    });

    expect(mgr.isAsserting()).toBe(false);

    mgr.startTask();
    expect(mgr.getActiveTaskCount()).toBe(1);
    expect(mgr.isAsserting()).toBe(true);
    expect(fakeSpawn).toHaveBeenCalledWith('caffeinate', ['-i', '-s'], {
      detached: true,
      stdio: 'ignore',
    });
    expect(fakeProc.unref).toHaveBeenCalled();

    mgr.startTask();
    expect(mgr.getActiveTaskCount()).toBe(2);
    expect(fakeSpawn).toHaveBeenCalledTimes(1);

    mgr.endTask();
    expect(mgr.getActiveTaskCount()).toBe(1);
    expect(mgr.isAsserting()).toBe(true);
    expect(fakeProc.kill).not.toHaveBeenCalled();

    mgr.endTask();
    expect(mgr.getActiveTaskCount()).toBe(0);
    expect(mgr.isAsserting()).toBe(false);
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('releaseAll immediately terminates active assertion', () => {
    const fakeProc = {
      kill: vi.fn(),
      unref: vi.fn(),
    };
    const fakeSpawn = vi.fn().mockReturnValue(fakeProc);
    const mgr = new DynamicPowerManager({
      platform: 'darwin',
      spawnFn: fakeSpawn as any,
    });

    mgr.startTask();
    mgr.startTask();
    expect(mgr.isAsserting()).toBe(true);

    mgr.releaseAll();
    expect(mgr.getActiveTaskCount()).toBe(0);
    expect(mgr.isAsserting()).toBe(false);
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('cleans up orphaned assertions via spawnSync', () => {
    const fakeSpawnSync = vi.fn().mockReturnValue({ status: 0, stdout: 'SleepDisabled\t\t1' });
    const mgr = new DynamicPowerManager({
      platform: 'darwin',
      spawnSyncFn: fakeSpawnSync as any,
    });

    mgr.cleanupOrphanedAssertions();
    expect(fakeSpawnSync).toHaveBeenCalledWith('killall', ['caffeinate'], { stdio: 'ignore' });
    expect(fakeSpawnSync).toHaveBeenCalledWith('pmset', ['-g'], { encoding: 'utf-8' });
    expect(fakeSpawnSync).toHaveBeenCalledWith('sudo', ['-n', 'pmset', '-a', 'disablesleep', '0'], { stdio: 'ignore' });
  });
});
