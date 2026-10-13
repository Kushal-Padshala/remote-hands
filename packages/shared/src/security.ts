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

/**
 * Collapses `.`, `..` and repeated slashes so `/home/me/../../etc` is checked as `/etc`.
 * Pure string work: shared code also runs in Workers and the browser, where node:path is absent.
 */
function normalizePosixPath(p: string): string {
  const absolute = p.startsWith('/');
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(part);
  }
  return (absolute ? '/' : '') + out.join('/');
}

/**
 * The same for a Windows path: either slash, a drive letter or a network share (`\\server\share`) as the root that
 * `..` cannot climb above, and no difference between upper and lower case (Windows ignores it). `c:\Users\Ana\..\..\Windows`
 * is checked as `c:/windows`.
 */
function normalizeWindowsPath(p: string): string {
  const slashed = p.replace(/\\/g, '/');
  let root = '';
  let rest = slashed;
  const unc = /^\/\/([^/]+)\/([^/]+)(.*)$/.exec(slashed);
  const drive = /^([A-Za-z]):(.*)$/.exec(slashed);
  if (unc) {
    root = `//${unc[1]}/${unc[2]}`;
    rest = unc[3] ?? '';
  } else if (drive) {
    root = `${drive[1]}:`;
    rest = drive[2] ?? '';
  }
  const absolute = root !== '' || rest.startsWith('/');
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
  // a share's own root has no trailing slash (`//server/share`); a drive's has (`c:/`)
  if (root.startsWith('//')) return (root + (out.length > 0 ? `/${out.join('/')}` : '')).toLowerCase();
  const prefix = root !== '' ? `${root}/` : absolute ? '/' : '';
  return (prefix + out.join('/')).toLowerCase();
}

/** `C:work` or `C:` mean "relative to the current folder on drive C": where that is depends on the computer, so it is never checked as `C:\\work`. */
const isDriveRelative = (p: string): boolean => /^[A-Za-z]:(?![\\/])/.test(p);

export interface WorkspacePathOptions {
  /** Check as a Windows path: either slash, drive letters and shares, case ignored. Off, paths are checked exactly as on Mac and Linux. */
  windows?: boolean | undefined;
}

export function isSafeWorkspacePath(
  targetPath: string,
  allowlist?: readonly string[] | undefined,
  options: WorkspacePathOptions = {},
): { allowed: boolean; reason?: string } {
  const windows = options.windows === true;
  const normalizePath = windows ? normalizeWindowsPath : normalizePosixPath;
  if (windows && typeof targetPath === 'string' && isDriveRelative(targetPath.trim())) {
    return { allowed: false, reason: 'Drive-relative paths (like C:work) are not allowed: write the full path (C:\\work)' };
  }
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
  // Windows: the system folders of any drive (the path is lower case, see normalizeWindowsPath)
  if (windows) {
    const system = /^[a-z]:\/(windows|program files|program files \(x86\)|programdata)(\/|$)/.exec(normalized);
    if (system) return { allowed: false, reason: `Access to system directory "${system[1]}" is forbidden` };
  }

  const forbiddenSubdirs = ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.config/gh', '.kube', '.docker', 'Library/Keychains'];
  const subject = normalized;
  for (const sub of forbiddenSubdirs) {
    const needle = windows ? sub.toLowerCase() : sub;
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
      // an allowlist entry that is drive-relative names no fixed folder, so it allows nothing
      if (windows && isDriveRelative(allowed.trim())) return false;
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
