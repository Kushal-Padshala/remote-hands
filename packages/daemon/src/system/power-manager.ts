import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

export interface PowerManagerOptions {
  platform?: string | undefined;
  spawnFn?: typeof spawn | undefined;
  spawnSyncFn?: typeof spawnSync | undefined;
}

export class DynamicPowerManager {
  private activeTaskCount = 0;
  private caffeinateProc: ChildProcess | null = null;
  private platform: string;
  private spawnFn: typeof spawn;
  private spawnSyncFn: typeof spawnSync;

  constructor(options: PowerManagerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.spawnFn = options.spawnFn ?? spawn;
    this.spawnSyncFn = options.spawnSyncFn ?? spawnSync;
  }

  isAsserting(): boolean {
    return this.caffeinateProc !== null;
  }

  getActiveTaskCount(): number {
    return this.activeTaskCount;
  }

  startTask(): void {
    this.activeTaskCount++;
    if (this.activeTaskCount === 1) {
      this.acquireWakeAssertion();
    }
  }

  endTask(): void {
    this.activeTaskCount = Math.max(0, this.activeTaskCount - 1);
    if (this.activeTaskCount === 0) {
      this.releaseWakeAssertion();
    }
  }

  acquireWakeAssertion(): void {
    if (this.platform !== 'darwin') return;
    if (this.caffeinateProc) return;
    try {
      this.caffeinateProc = this.spawnFn('caffeinate', ['-i', '-s'], {
        detached: true,
        stdio: 'ignore',
      });
      if (this.caffeinateProc && typeof this.caffeinateProc.unref === 'function') {
        this.caffeinateProc.unref();
      }
    } catch {}
  }

  releaseWakeAssertion(): void {
    if (this.caffeinateProc) {
      try {
        this.caffeinateProc.kill('SIGTERM');
      } catch {}
      this.caffeinateProc = null;
    }
  }

  releaseAll(): void {
    this.activeTaskCount = 0;
    this.releaseWakeAssertion();
  }

  cleanupOrphanedAssertions(): void {
    if (this.platform !== 'darwin') return;
    try {
      this.spawnSyncFn('killall', ['caffeinate'], { stdio: 'ignore' });
    } catch {}
    try {
      const pmRes = this.spawnSyncFn('pmset', ['-g'], { encoding: 'utf-8' });
      if (pmRes.stdout && pmRes.stdout.includes('SleepDisabled\t\t1')) {
        this.spawnSyncFn('sudo', ['-n', 'pmset', '-a', 'disablesleep', '0'], { stdio: 'ignore' });
      }
    } catch {}
  }
}
