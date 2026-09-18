import { randomUUID } from 'crypto';
import {
  startPairingRequestSchema,
  claimPairingRequestSchema,
  timingSafeEqualStr,
} from '@remote-hands/shared';
import {
  generatePairingCode,
  hashPairingCode,
  canClaimPairingToken,
} from '@remote-hands/control-plane';
import { requireOwnerSession, requireSession, createSessionToken, hashSessionToken } from '../auth/session.js';
import { PairingRepository } from '../d1/pairing-repository.js';
import { MachinesRepository } from '../d1/machines-repository.js';
import { SessionsRepository } from '../d1/sessions-repository.js';
import { NotFoundError } from '../http/errors.js';
import { jsonOk } from '../http/json.js';
import type { Env } from '../env.js';

export async function handleStartPairing(request: Request, env: Env): Promise<Response> {
  const session = await requireOwnerSession(request, env.DB);
  const body = startPairingRequestSchema.parse(await request.json());

  const code = generatePairingCode();
  const salt = randomUUID();
  const hash = await hashPairingCode(code, salt);

  const tokenId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();

  const pairingRepo = new PairingRepository(env.DB);
  await pairingRepo.create({
    id: tokenId,
    owner_id: session.owner_id,
    machine_name: body.machine_name,
    code_hash: `${salt}:${hash}`,
    expires_at: expiresAt,
    claimed_at: null,
    created_at: now.toISOString(),
  });

  return jsonOk(
    {
      token_id: tokenId,
      pairing_code: code,
      expires_at: expiresAt,
    },
    201,
  );
}

export async function handleClaimPairing(request: Request, env: Env): Promise<Response> {
  const body = claimPairingRequestSchema.parse(await request.json());
  const now = new Date();

  const res = await env.DB
    .prepare(`SELECT * FROM pairing_tokens WHERE claimed_at IS NULL`)
    .all<any>();
  const unclaimedTokens = res.results ?? [];

  let matchedToken: any = null;
  for (const token of unclaimedTokens) {
    const parts = (token.code_hash || '').split(':');
    if (parts.length === 2) {
      const [salt, expectedHash] = parts;
      const computedHash = await hashPairingCode(body.pairing_code, salt);
      if (timingSafeEqualStr(computedHash, expectedHash) && canClaimPairingToken(token, now)) {
        matchedToken = token;
        break;
      }
    }
  }

  if (!matchedToken) {
    throw new NotFoundError('Invalid or expired pairing code');
  }

  const pairingRepo = new PairingRepository(env.DB);
  await pairingRepo.markClaimed(matchedToken.id, now.toISOString());

  const machineId = randomUUID();
  const machinesRepo = new MachinesRepository(env.DB);
  await machinesRepo.upsert({
    id: machineId,
    owner_id: matchedToken.owner_id,
    name: matchedToken.machine_name,
    hostname: body.hostname,
    daemon_version: body.daemon_version ?? null,
    agy_version: body.agy_version ?? null,
    status: 'online',
    last_seen_at: now.toISOString(),
    created_at: now.toISOString(),
  });

  const rawSessionToken = createSessionToken();
  const tokenHash = await hashSessionToken(rawSessionToken);
  const sessionExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const sessionsRepo = new SessionsRepository(env.DB);
  await sessionsRepo.create({
    id: randomUUID(),
    owner_id: matchedToken.owner_id,
    machine_id: machineId,
    kind: 'daemon',
    token_hash: tokenHash,
    expires_at: sessionExpiresAt,
    created_at: now.toISOString(),
  });

  return jsonOk(
    {
      ok: true,
      machine_id: machineId,
      session_token: rawSessionToken,
      expires_at: sessionExpiresAt,
    },
    201,
  );
}

export async function handleCreatePhoneSession(request: Request, env: Env): Promise<Response> {
  const session = await requireOwnerSession(request, env.DB);
  const now = new Date();
  const rawSessionToken = createSessionToken();
  const tokenHash = await hashSessionToken(rawSessionToken);
  const sessionExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const sessionsRepo = new SessionsRepository(env.DB);
  await sessionsRepo.create({
    id: randomUUID(),
    owner_id: session.owner_id,
    machine_id: null,
    kind: 'phone',
    token_hash: tokenHash,
    expires_at: sessionExpiresAt,
    created_at: now.toISOString(),
  });

  return jsonOk(
    {
      ok: true,
      owner_id: session.owner_id,
      session_token: rawSessionToken,
      expires_at: sessionExpiresAt,
    },
    201,
  );
}

