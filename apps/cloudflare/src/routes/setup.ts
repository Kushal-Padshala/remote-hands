import { randomUUID } from 'crypto';
import { setupOwnerRequestSchema, timingSafeEqualStr } from '@remote-hands/shared';
import { createSessionToken, hashSessionToken } from '../auth/session.js';
import { SessionsRepository } from '../d1/sessions-repository.js';
import { UnauthorizedError } from '../http/errors.js';
import { jsonOk, jsonError } from '../http/json.js';
import type { Env } from '../env.js';

export async function handleSetupOwner(request: Request, env: Env): Promise<Response> {
  const existingOwner = await env.DB
    .prepare("SELECT id FROM sessions WHERE kind = 'phone' LIMIT 1")
    .first();
  if (existingOwner) {
    return jsonError('Owner is already configured', 409);
  }

  const body = setupOwnerRequestSchema.parse(await request.json());
  const hashedSecret = await hashSessionToken(body.owner_secret);

  if (env.OWNER_SECRET_HASH && !timingSafeEqualStr(env.OWNER_SECRET_HASH, hashedSecret)) {
    throw new UnauthorizedError('Invalid owner secret');
  }

  const rawSessionToken = createSessionToken();
  const tokenHash = await hashSessionToken(rawSessionToken);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const ownerId = randomUUID();

  const sessionsRepo = new SessionsRepository(env.DB);
  await sessionsRepo.create({
    id: randomUUID(),
    owner_id: ownerId,
    machine_id: null,
    kind: 'phone',
    token_hash: tokenHash,
    expires_at: expiresAt,
    created_at: now.toISOString(),
  });

  return jsonOk(
    {
      ok: true,
      owner_id: ownerId,
      session_token: rawSessionToken,
      expires_at: expiresAt,
    },
    201,
  );
}
