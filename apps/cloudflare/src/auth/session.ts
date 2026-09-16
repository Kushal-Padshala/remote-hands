import { SessionsRepository, type SessionRow } from '../d1/sessions-repository.js';
import { UnauthorizedError, ForbiddenError } from '../http/errors.js';
import type { D1Database } from '../env.js';

export function createSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function hashSessionToken(token: string): Promise<string> {
  const encoded = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function authenticateRequest(
  request: Request,
  db: D1Database,
): Promise<SessionRow | null> {
  let rawToken: string | null = null;
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    rawToken = authHeader.slice(7).trim();
  } else {
    try {
      const url = new URL(request.url);
      rawToken = url.searchParams.get('token');
    } catch {}
  }

  if (!rawToken) {
    return null;
  }

  const tokenHash = await hashSessionToken(rawToken);
  const sessionsRepo = new SessionsRepository(db);
  const session = await sessionsRepo.getByTokenHash(tokenHash);
  if (!session) {
    return null;
  }
  if (new Date().getTime() > Date.parse(session.expires_at)) {
    return null;
  }
  return session;
}

export async function requireSession(request: Request, db: D1Database): Promise<SessionRow> {
  const session = await authenticateRequest(request, db);
  if (!session) {
    throw new UnauthorizedError('Valid session token required');
  }
  return session;
}

export async function requireOwnerSession(request: Request, db: D1Database): Promise<SessionRow> {
  const session = await requireSession(request, db);
  if (session.kind !== 'phone') {
    throw new ForbiddenError('Owner session required');
  }
  return session;
}
