import { describe, expect, it } from 'vitest';
import { timingSafeEqualStr, isSafeWorkspacePath, isSafeBrowserUrl } from './security.js';

describe('Security Utilities', () => {
  it('correctly compares strings in constant time', () => {
    expect(timingSafeEqualStr('hello', 'hello')).toBe(true);
    expect(timingSafeEqualStr('hello', 'world')).toBe(false);
    expect(timingSafeEqualStr('hello', 'hell')).toBe(false);
    expect(timingSafeEqualStr('', '')).toBe(true);
  });

  it('rejects forbidden and credential workspace paths', () => {
    expect(isSafeWorkspacePath('/etc/passwd').allowed).toBe(false);
    expect(isSafeWorkspacePath('/root/secrets').allowed).toBe(false);
    expect(isSafeWorkspacePath('/home/user/.ssh').allowed).toBe(false);
    expect(isSafeWorkspacePath('/home/user/.ssh/id_rsa').allowed).toBe(false);
    expect(isSafeWorkspacePath('/home/user/.aws/credentials').allowed).toBe(false);
    expect(isSafeWorkspacePath('/home/user/projects/my-app').allowed).toBe(true);
  });

  it('enforces workspace allowlist if configured', () => {
    const allowlist = ['/Users/kushal/projects/app', '/tmp/work'];
    expect(isSafeWorkspacePath('/Users/kushal/projects/app/src', allowlist).allowed).toBe(true);
    expect(isSafeWorkspacePath('/tmp/work/output.txt', allowlist).allowed).toBe(true);
    expect(isSafeWorkspacePath('/Users/kushal/secrets', allowlist).allowed).toBe(false);
  });

  it('validates browser URLs to prevent command argument injection', () => {
    expect(isSafeBrowserUrl('https://github.com')).toBe(true);
    expect(isSafeBrowserUrl('http://localhost:3000')).toBe(true);
    expect(isSafeBrowserUrl('about:blank')).toBe(true);
    expect(isSafeBrowserUrl('--disable-web-security')).toBe(false);
    expect(isSafeBrowserUrl('--load-extension=/evil')).toBe(false);
    expect(isSafeBrowserUrl('-p')).toBe(false);
  });
});
