import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  checkMacFullDiskAccess,
  checkMacScreenCapture,
  checkMacAccessibility,
  detectHostAppName,
  openMacPrivacySettings,
  ensureMacPermissions,
  requestMacScreenCapture,
} from './mac-permissions.js';


describe('mac-permissions', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.restoreAllMocks();
  });

  it('returns true on non-darwin platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(checkMacFullDiskAccess()).toBe(true);
    expect(checkMacScreenCapture()).toBe(true);
    expect(checkMacAccessibility()).toBe(true);
  });

  it('detects host app name from environment variables', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const origEnv = { ...process.env };
    try {
      delete process.env.__CFBundleIdentifier;
      process.env.TERM_PROGRAM = 'Apple_Terminal';
      expect(detectHostAppName()).toBe('Terminal');

      process.env.TERM_PROGRAM = 'iTerm.app';
      expect(detectHostAppName()).toBe('iTerm');

      process.env.TERM_PROGRAM = 'WarpTerminal';
      expect(detectHostAppName()).toBe('Warp');

      process.env.TERM_PROGRAM = 'ghostty';
      expect(detectHostAppName()).toBe('Ghostty');

      delete process.env.TERM_PROGRAM;
      process.env.__CFBundleIdentifier = 'com.google.antigravity-ide';
      expect(detectHostAppName()).toBe('Antigravity IDE');
    } finally {
      process.env = origEnv;
    }
  });

  it('opens privacy settings for screen capture, accessibility, and full disk access without throwing', () => {
    expect(() => openMacPrivacySettings('ScreenCapture')).not.toThrow();
    expect(() => openMacPrivacySettings('Accessibility')).not.toThrow();
    expect(() => openMacPrivacySettings('FullDiskAccess')).not.toThrow();
    expect(() => openMacPrivacySettings('Automation')).not.toThrow();
    expect(() => openMacPrivacySettings('AppManagement')).not.toThrow();
  });

  it('immediately returns true when on non-darwin platform during ensureMacPermissions', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const stdout = vi.fn();
    const result = await ensureMacPermissions(stdout);
    expect(result).toBe(true);
    expect(stdout).not.toHaveBeenCalled();
  });

  it('runs requestMacScreenCapture without throwing', () => {
    expect(() => requestMacScreenCapture()).not.toThrow();
  });


  describe('ensureMacPermissions on a Mac', () => {
    function world(initial: { screen?: boolean; access?: boolean; fda?: boolean }) {
      const state = { screen: initial.screen ?? false, access: initial.access ?? false, fda: initial.fda ?? false };
      const opened: string[] = [];
      const out: string[] = [];
      const deps = {
        checkScreen: () => state.screen,
        checkFullDisk: () => state.fda,
        checkAccessibility: () => state.access,
        requestScreen: () => {},
        openPane: (pane: string) => opened.push(pane),
        promptAccessibility: () => 'unavailable' as const,
        helperPresent: () => false,
        prepareHelper: async () => {},
        isTTY: false,
        pollMs: 5,
        waitMs: 400,
        hostApp: 'Terminal',
        nodePath: '/Users/x/.nvm/versions/node/v22/bin/node',
      };
      return { state, opened, out, deps, stdout: (m: string) => out.push(m) };
    }
    const asDarwin = () => Object.defineProperty(process, 'platform', { value: 'darwin' });

    it('opens one System Settings page at a time and moves to the next when one is granted', async () => {
      asDarwin();
      const w = world({});
      const run = ensureMacPermissions(w.stdout, 74, { fullDiskAccessOptional: true }, w.deps as any);
      await new Promise((r) => setTimeout(r, 40));
      expect(w.opened).toEqual(['ScreenCapture']);
      w.state.screen = true;
      await new Promise((r) => setTimeout(r, 40));
      expect(w.opened).toEqual(['ScreenCapture', 'Accessibility']);
      w.state.access = true;
      expect(await run).toBe(true);
      expect(w.opened).not.toContain('FullDiskAccess');
    });

    it('does not ask for or wait on Full Disk Access when it is optional', async () => {
      asDarwin();
      const w = world({ screen: true, access: true, fda: false });
      expect(await ensureMacPermissions(w.stdout, 74, { fullDiskAccessOptional: true }, w.deps as any)).toBe(true);
      expect(w.opened).toEqual([]);
      expect(w.out.join('\n')).toContain('optional');
    });

    it('still asks for Full Disk Access for the remote flow (not optional)', async () => {
      asDarwin();
      const w = world({ screen: true, access: true, fda: false });
      const run = ensureMacPermissions(w.stdout, 74, {}, w.deps as any);
      await new Promise((r) => setTimeout(r, 40));
      expect(w.opened).toEqual(['FullDiskAccess']);
      w.state.fda = true;
      expect(await run).toBe(true);
    });

    it('names the real node program and how to reach a hidden folder', async () => {
      asDarwin();
      const w = world({});
      const run = ensureMacPermissions(w.stdout, 74, { fullDiskAccessOptional: true }, w.deps as any);
      await new Promise((r) => setTimeout(r, 40));
      w.state.screen = true;
      w.state.access = true;
      await run;
      const text = w.out.join('\n');
      expect(text).toContain('/Users/x/.nvm/versions/node/v22/bin/node');
      expect(text).toContain('Cmd+Shift+G');
      expect(text).toContain('Quit & Reopen');
    });

    it('with nobody at the terminal it gives up after the wait and reports what is missing', async () => {
      asDarwin();
      const w = world({});
      w.deps.waitMs = 30;
      expect(await ensureMacPermissions(w.stdout, 74, { fullDiskAccessOptional: true }, w.deps as any)).toBe(false);
    });

    it('says everything is verified at once when nothing is missing', async () => {
      asDarwin();
      const w = world({ screen: true, access: true, fda: true });
      expect(await ensureMacPermissions(w.stdout, 74, {}, w.deps as any)).toBe(true);
      expect(w.out.join('\n')).toContain('Accessibility verified');
      expect(w.opened).toEqual([]);
    });
  });
});
