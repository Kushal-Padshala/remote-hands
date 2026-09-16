export interface PairingTokenRecord {
  id: string;
  expires_at: string;
  claimed_at: string | null;
}

export function generatePairingCode(length: number = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => (b % 10).toString())
    .join('');
}

export async function hashPairingCode(code: string, salt: string): Promise<string> {
  const data = `${salt}:${code}`;
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
