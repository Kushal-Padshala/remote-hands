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

describe('Windows workspace paths (opt in)', () => {
  const win = { windows: true };
  const check = (p: string, allow?: string[]) => isSafeWorkspacePath(p, allow, win).allowed;

  it('treats backslashes and drive letters as the Windows path they are, so traversal and credential folders are caught', () => {
    expect(check('C:\\Users\\Ana\\work\\app')).toBe(true);
    expect(check('C:\\Users\\Ana\\.ssh')).toBe(false);
    expect(check('c:/users/ana/.AWS/credentials')).toBe(false);
    expect(check('C:\\Users\\Ana\\work\\..\\.ssh')).toBe(false);
    expect(check('C:\\Users\\Ana\\AppData\\Roaming\\gcloud')).toBe(true);
    expect(check('C:\\Users\\Ana\\.config\\gcloud')).toBe(false);
  });

  it('refuses the Windows system folders on any drive, in any case', () => {
    for (const bad of ['C:\\Windows', 'c:\\windows\\system32', 'D:/Program Files/App', 'C:\\Program Files (x86)\\x', 'C:\\ProgramData\\x', 'C:\\Users\\Ana\\..\\..\\Windows\\System32']) {
      expect(check(bad), bad).toBe(false);
    }
    expect(check('C:\\Windowsfoo\\x')).toBe(true);
  });

  it('keeps an allowlist inside its folder even with mixed separators and traversal, and ignores case', () => {
    const allow = ['C:/work'];
    expect(check('C:\\work\\app', allow)).toBe(true);
    expect(check('c:\\WORK', allow)).toBe(true);
    expect(check('C:/work/..\\Users\\Ana\\.ssh', allow)).toBe(false);
    expect(check('C:/work/../other', allow)).toBe(false);
    expect(check('D:\\work', allow)).toBe(false);
    expect(check('C:\\workshop', allow)).toBe(false);
  });

  it('knows network shares in either slash spelling, and `..` cannot climb above the share', () => {
    expect(check('\\\\server\\share\\project')).toBe(true);
    expect(check('\\\\server\\share\\project\\.ssh')).toBe(false);
    expect(check('//server/share/project/.SSH')).toBe(false);
    expect(check('\\\\server\\share\\..\\project', ['\\\\server\\share'])).toBe(true);
    expect(check('//server/share/../../../project', ['//server/share'])).toBe(true);
    expect(check('//server/share/project', ['\\\\server\\share'])).toBe(true);
    expect(check('\\\\server\\other\\project', ['\\\\server\\share'])).toBe(false);
  });
});

describe('without the Windows option, paths are checked exactly as before (drive-shaped names are just names)', () => {
  it('keeps case and backslashes as they are', () => {
    // a relative directory literally named "C:" on a case-sensitive file system
    expect(isSafeWorkspacePath('C:/Work/private', ['C:/work']).allowed).toBe(false);
    expect(isSafeWorkspacePath('C:/work/private', ['C:/work']).allowed).toBe(true);
    expect(isSafeWorkspacePath('C:/Windows/x').allowed).toBe(true);
    expect(isSafeWorkspacePath('/home/user/odd\\name').allowed).toBe(true);
    expect(isSafeWorkspacePath('/home/user/odd\\.ssh').allowed).toBe(true);
    expect(isSafeWorkspacePath('/home/user/.ssh').allowed).toBe(false);
    expect(isSafeWorkspacePath('\\\\server\\share\\project').allowed).toBe(true);
  });
});
