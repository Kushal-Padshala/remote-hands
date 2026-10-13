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

  it('resolves dot segments before checking', () => {
    expect(isSafeWorkspacePath('/home/user/../../etc').allowed).toBe(false);
    expect(isSafeWorkspacePath('/home/user/projects/../.ssh').allowed).toBe(false);
    expect(isSafeWorkspacePath('/home/user/./.kube/config').allowed).toBe(false);
    expect(isSafeWorkspacePath('/home//user/projects/./app').allowed).toBe(true);
    expect(isSafeWorkspacePath('/tmp/work/../../Users/kushal/secrets', ['/tmp/work']).allowed).toBe(false);
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
    expect(isSafeBrowserUrl('file:///Users/me/.ssh/id_rsa')).toBe(false);
  });
});

describe('Windows workspace paths', () => {
  it('treats backslashes and drive letters as the Windows path they are, so traversal and credential folders are caught', () => {
    expect(isSafeWorkspacePath('C:\\Users\\Ana\\work\\app').allowed).toBe(true);
    expect(isSafeWorkspacePath('C:\\Users\\Ana\\.ssh').allowed).toBe(false);
    expect(isSafeWorkspacePath('c:/users/ana/.AWS/credentials').allowed).toBe(false);
    expect(isSafeWorkspacePath('C:\\Users\\Ana\\work\\..\\.ssh').allowed).toBe(false);
    expect(isSafeWorkspacePath('C:\\Users\\Ana\\AppData\\Roaming\\gcloud').allowed).toBe(true);
    expect(isSafeWorkspacePath('C:\\Users\\Ana\\.config\\gcloud').allowed).toBe(false);
  });

  it('refuses the Windows system folders on any drive, in any case', () => {
    for (const bad of ['C:\\Windows', 'c:\\windows\\system32', 'D:/Program Files/App', 'C:\\Program Files (x86)\\x', 'C:\\ProgramData\\x', 'C:\\Users\\Ana\\..\\..\\Windows\\System32']) {
      expect(isSafeWorkspacePath(bad).allowed, bad).toBe(false);
    }
    expect(isSafeWorkspacePath('C:\\Windowsfoo\\x').allowed).toBe(true);
  });

  it('keeps an allowlist inside its folder even with mixed separators and traversal, and ignores case', () => {
    const allow = ['C:/work'];
    expect(isSafeWorkspacePath('C:\\work\\app', allow).allowed).toBe(true);
    expect(isSafeWorkspacePath('c:\\WORK', allow).allowed).toBe(true);
    expect(isSafeWorkspacePath('C:/work/..\\Users\\Ana\\.ssh', allow).allowed).toBe(false);
    expect(isSafeWorkspacePath('C:/work/../other', allow).allowed).toBe(false);
    expect(isSafeWorkspacePath('D:\\work', allow).allowed).toBe(false);
    expect(isSafeWorkspacePath('C:\\workshop', allow).allowed).toBe(false);
  });

  it('knows network shares and leaves Unix paths exactly as they were', () => {
    expect(isSafeWorkspacePath('\\\\server\\share\\project').allowed).toBe(true);
    expect(isSafeWorkspacePath('\\\\server\\share\\project\\.ssh').allowed).toBe(false);
    // a backslash in a Unix name is just a character
    expect(isSafeWorkspacePath('/home/user/odd\\name').allowed).toBe(true);
    expect(isSafeWorkspacePath('/home/user/odd\\.ssh').allowed).toBe(true);
    expect(isSafeWorkspacePath('/home/user/.ssh').allowed).toBe(false);
  });
});
