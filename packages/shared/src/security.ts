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

export function isSafeWorkspacePath(
  targetPath: string,
  allowlist?: readonly string[] | undefined,
): { allowed: boolean; reason?: string } {
  if (!targetPath || typeof targetPath !== 'string') {
    return { allowed: false, reason: 'Invalid workspace path' };
  }

  const normalized = targetPath.trim();
  if (normalized.length === 0) {
    return { allowed: false, reason: 'Empty workspace path' };
  }

  const forbiddenSystemPaths = ['/etc', '/root', '/bin', '/sbin', '/usr', '/dev', '/proc', '/sys'];
  for (const forbidden of forbiddenSystemPaths) {
    if (normalized === forbidden || normalized.startsWith(forbidden + '/')) {
      return { allowed: false, reason: `Access to system directory "${forbidden}" is forbidden` };
    }
  }

  const forbiddenSubdirs = ['.ssh', '.aws', '.gnupg', '.config/gcloud'];
  for (const sub of forbiddenSubdirs) {
    if (
      normalized.endsWith('/' + sub) ||
      normalized.includes('/' + sub + '/') ||
      normalized === sub ||
      normalized.startsWith(sub + '/')
    ) {
      return { allowed: false, reason: `Access to credential directory "${sub}" is forbidden` };
    }
  }

  if (allowlist && allowlist.length > 0) {
    const isAllowed = allowlist.some((allowed) => {
      const trimmedAllowed = allowed.trim();
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
    trimmed.startsWith('about:') ||
    trimmed.startsWith('file://')
  );
}
