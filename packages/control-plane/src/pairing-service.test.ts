import { describe, expect, it } from 'vitest';
import {
  generatePairingCode,
  hashPairingCode,
  canClaimPairingToken,
  claimPairingToken,
} from './pairing-service.js';

describe('pairing service rules', () => {
  it('generates a 6-digit numeric pairing code by default', () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^\d{6}$/);
  });

  it('hashes pairing code with salt deterministically using sha256', async () => {
    const hash1 = await hashPairingCode('123456', 'test-salt');
    const hash2 = await hashPairingCode('123456', 'test-salt');
    const hashDifferent = await hashPairingCode('654321', 'test-salt');

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe('123456');
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
