export interface PairingTokenRecord {
  id: string;
  expires_at: string;
  claimed_at: string | null;
}

export function normalizePairingCode(code: string): string {
  return code.trim().replace(/^RH-?/i, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export function generatePairingCode(
  optionsOrLength?: number | { length?: number; prefix?: string } | undefined,
): string {
  const isNum = typeof optionsOrLength === 'number';
  const length = isNum ? optionsOrLength : (optionsOrLength?.length ?? 12);
  const prefix = isNum ? '' : (optionsOrLength?.prefix !== undefined ? optionsOrLength.prefix : 'RH');
  const charset = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes).map((b) => charset[b % charset.length]);

  let formatted = '';
  for (let i = 0; i < chars.length; i++) {
    if (i > 0 && i % 4 === 0) {
      formatted += '-';
    }
    formatted += chars[i];
  }

  return prefix ? `${prefix}-${formatted}` : formatted;
}

export async function hashPairingCode(code: string, salt: string): Promise<string> {
  const normalized = normalizePairingCode(code);
  const data = `${salt}:${normalized}`;
  const encoded = new TextEncoder().encode(data);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function isPairingTokenExpired(expiresAt: string, now: Date = new Date()): boolean {
  return now.getTime() > Date.parse(expiresAt);
}

export function canClaimPairingToken(token: PairingTokenRecord, now: Date = new Date()): boolean {
  if (token.claimed_at !== null) {
    return false;
  }
  return !isPairingTokenExpired(token.expires_at, now);
}

export function claimPairingToken<T extends PairingTokenRecord>(token: T, now: Date = new Date()): T {
  if (!canClaimPairingToken(token, now)) {
    throw new Error('Pairing token cannot be claimed: expired or already claimed');
  }
  return {
    ...token,
    claimed_at: now.toISOString(),
  };
}
