export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < aBuf.byteLength; i++) {
    diff |= aBuf[i]! ^ bBuf[i]!;
  }
  return diff === 0;
}

/** A Windows path: `C:\\work`, `c:/work` or a network path `\\\\server\\share`. */
const looksWindows = (p: string): boolean => /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith('\\\\');

/**
 * Collapses `.`, `..` and repeated slashes so `/home/me/../../etc` is checked as `/etc`. A Windows path (drive letter or
 * network share) is first written with forward slashes and a capital drive letter, and is compared without regard to case
 * (Windows ignores it), so `c:\Users\Ana\..\..\Windows` is checked as `C:/Windows`. Other paths are unchanged.
 * Pure string work: shared code also runs in Workers and the browser, where node:path is absent.
 */
function normalizePath(p: string): string {
  const windows = looksWindows(p);
  let rest = windows ? p.replace(/\\/g, '/') : p;
  let drive = '';
  if (windows) {
    const m = /^([A-Za-z]):/.exec(rest);
    if (m) {
      drive = `${m[1]!.toUpperCase()}:`;
      rest = rest.slice(2);
    }
  }
  const absolute = rest.startsWith('/') || drive !== '';
  const out: string[] = [];
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(part);
  }
  const joined = drive + (absolute ? '/' : '') + out.join('/');
  // a leading double slash marks a network share, which the collapse above would have flattened
  const share = windows && drive === '' && p.startsWith('\\\\') ? '/' : '';
  return (windows ? (share + joined).toLowerCase().replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`) : joined);
}

export function isSafeWorkspacePath(
  targetPath: string,
  allowlist?: readonly string[] | undefined,
): { allowed: boolean; reason?: string } {
  if (!targetPath || typeof targetPath !== 'string') {
    return { allowed: false, reason: 'Invalid workspace path' };
  }

  if (targetPath.trim().length === 0) {
    return { allowed: false, reason: 'Empty workspace path' };
  }
  const normalized = normalizePath(targetPath.trim());

  const forbiddenSystemPaths = ['/etc', '/root', '/bin', '/sbin', '/usr', '/dev', '/proc', '/sys'];
  for (const forbidden of forbiddenSystemPaths) {
    if (normalized === forbidden || normalized.startsWith(forbidden + '/')) {
      return { allowed: false, reason: `Access to system directory "${forbidden}" is forbidden` };
    }
  }
  // Windows: the system folders of any drive (paths are compared lower case, see normalizePath)
  if (looksWindows(targetPath.trim())) {
    const system = /^[A-Za-z]:\/(windows|program files|program files \(x86\)|programdata)(\/|$)/i.exec(normalized);
    if (system) return { allowed: false, reason: `Access to system directory "${system[1]}" is forbidden` };
  }

  const forbiddenSubdirs = ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.config/gh', '.kube', '.docker', 'Library/Keychains'];
  const windowsPath = looksWindows(targetPath.trim());
  const subject = windowsPath ? normalized.toLowerCase() : normalized;
  for (const sub of forbiddenSubdirs) {
    const needle = windowsPath ? sub.toLowerCase() : sub;
    if (
      subject.endsWith('/' + needle) ||
      subject.includes('/' + needle + '/') ||
      subject === needle ||
      subject.startsWith(needle + '/')
    ) {
      return { allowed: false, reason: `Access to credential directory "${sub}" is forbidden` };
    }
  }

  if (allowlist && allowlist.length > 0) {
    const isAllowed = allowlist.some((allowed) => {
      const trimmedAllowed = normalizePath(allowed.trim());
      return (
        normalized === trimmedAllowed ||
        normalized.startsWith(trimmedAllowed.endsWith('/') ? trimmedAllowed : trimmedAllowed + '/')
      );
    });
    if (!isAllowed) {
      return {
        allowed: false,
        reason: `Workspace path "${normalized}" is not within the configured workspace allowlist`,
      };
    }
  }

  return { allowed: true };
}

export function isSafeBrowserUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (trimmed.startsWith('-')) return false;
  return (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('about:')
  );
}
