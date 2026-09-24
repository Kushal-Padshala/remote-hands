import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  checkMacFullDiskAccess,
  checkMacScreenCapture,
  checkMacAccessibility,
  detectHostAppName,
  openMacPrivacySettings,
  ensureMacPermissions,
  grantMacAutomationPermissions,
  requestMacScreenCapture,
  probeMacAutomationPermissions,
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

  it('runs grantMacAutomationPermissions without throwing', () => {
    expect(() => grantMacAutomationPermissions()).not.toThrow();
  });

  it('runs requestMacScreenCapture without throwing', () => {
    expect(() => requestMacScreenCapture()).not.toThrow();
  });

  it('runs probeMacAutomationPermissions without throwing', () => {
    expect(() => probeMacAutomationPermissions()).not.toThrow();
  });
});

