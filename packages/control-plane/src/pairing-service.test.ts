import { describe, expect, it } from 'vitest';
import {
  generatePairingCode,
  hashPairingCode,
  canClaimPairingToken,
  claimPairingToken,
} from './pairing-service.js';

describe('pairing service rules', () => {
  it('generates a cryptographically strong pairing code by default', () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^RH-[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  });

  it('hashes pairing code with salt deterministically and normalizes formatting', async () => {
    const hash1 = await hashPairingCode('RH-4K9M-2X7W-9P3V', 'test-salt');
    const hash2 = await hashPairingCode('rh-4k9m-2x7w-9p3v', 'test-salt');
    const hash3 = await hashPairingCode('4K9M2X7W9P3V', 'test-salt');
    const hashDifferent = await hashPairingCode('RH-ZZZZ-YYYY-XXXX', 'test-salt');

    expect(hash1).toBe(hash2);
    expect(hash1).toBe(hash3);
    expect(hash1).not.toBe('RH-4K9M-2X7W-9P3V');
    expect(hash1).not.toBe(hashDifferent);
    expect(hash1).toHaveLength(64);
  });

  it('validates claimability based on expiry and claimed status', () => {
    const now = new Date('2026-09-16T12:00:00.000Z');
    const validToken = {
      id: 'token-1',
      expires_at: '2026-09-16T12:10:00.000Z',
      claimed_at: null,
    };
    const expiredToken = {
      id: 'token-2',
      expires_at: '2026-09-16T11:59:00.000Z',
      claimed_at: null,
    };
    const claimedToken = {
      id: 'token-3',
      expires_at: '2026-09-16T12:10:00.000Z',
      claimed_at: '2026-09-16T12:01:00.000Z',
    };

    expect(canClaimPairingToken(validToken, now)).toBe(true);
    expect(canClaimPairingToken(expiredToken, now)).toBe(false);
    expect(canClaimPairingToken(claimedToken, now)).toBe(false);
  });

  it('claims a valid token and updates claimed_at', () => {
    const now = new Date('2026-09-16T12:00:00.000Z');
    const token = {
      id: 'token-1',
      expires_at: '2026-09-16T12:10:00.000Z',
      claimed_at: null,
    };

    const claimed = claimPairingToken(token, now);
    expect(claimed.claimed_at).toBe(now.toISOString());
    expect(canClaimPairingToken(claimed, now)).toBe(false);
  });

  it('throws when attempting to claim an invalid or expired token', () => {
    const now = new Date('2026-09-16T12:00:00.000Z');
    const expiredToken = {
      id: 'token-2',
      expires_at: '2026-09-16T11:59:00.000Z',
      claimed_at: null,
    };

    expect(() => claimPairingToken(expiredToken, now)).toThrow(/cannot be claimed/i);
  });
});
