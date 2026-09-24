import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HudServiceManager, generateHudPlistXml } from './hud-service.js';

describe('HudServiceManager', () => {
  let tmpDir: string;
  let testPlist: string;
  let mockExec: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-service-test-'));
    testPlist = path.join(tmpDir, 'test.plist');
    mockExec = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
  });

  it('generates valid plist xml with node, cli path, and log directory', () => {
    const xml = generateHudPlistXml('/usr/local/bin/node', '/usr/local/bin/rh', '/logs');
    expect(xml).toContain('<string>com.remote-hands.hud</string>');
    expect(xml).toContain('<string>/usr/local/bin/node</string>');
    expect(xml).toContain('<string>/usr/local/bin/rh</string>');
    expect(xml).toContain('<string>hud</string>');
    expect(xml).toContain('<string>listen</string>');
    expect(xml).toContain('<key>KeepAlive</key>');
  });

  it('installs plist file and triggers launchctl load', () => {
    const manager = new HudServiceManager({
      exec: mockExec,
      plistPath: testPlist,
    });

    const res = manager.install('/custom/path/to/rh');
    expect(res.success).toBe(true);
    expect(fs.existsSync(testPlist)).toBe(true);
    const content = fs.readFileSync(testPlist, 'utf-8');
    expect(content).toContain('/custom/path/to/rh');
    expect(mockExec).toHaveBeenCalledWith('launchctl', ['unload', testPlist]);
    expect(mockExec).toHaveBeenCalledWith('launchctl', ['load', '-w', testPlist]);
  });

  it('uninstalls plist file and triggers launchctl unload', () => {
    fs.writeFileSync(testPlist, 'dummy', 'utf-8');
    const manager = new HudServiceManager({
      exec: mockExec,
      plistPath: testPlist,
    });

    expect(manager.isInstalled()).toBe(true);
    const uninstalled = manager.uninstall();
    expect(uninstalled).toBe(true);
    expect(fs.existsSync(testPlist)).toBe(false);
    expect(mockExec).toHaveBeenCalledWith('launchctl', ['unload', '-w', testPlist]);
  });

  it('checks running status via launchctl list', () => {
    mockExec.mockReturnValue({
      stdout: '1234 0 com.remote-hands.hud\n5678 0 other.service',
      stderr: '',
      status: 0,
    });
    const manager = new HudServiceManager({
      exec: mockExec,
      plistPath: testPlist,
    });
    expect(manager.isRunning()).toBe(true);

    mockExec.mockReturnValue({
      stdout: '5678 0 other.service',
      stderr: '',
      status: 0,
    });
    expect(manager.isRunning()).toBe(false);
  });
});
