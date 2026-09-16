import { z } from 'zod';
import type { Env } from './env.js';
import { HttpError } from './http/errors.js';
import { jsonError, jsonOk } from './http/json.js';
import { handleSetupOwner } from './routes/setup.js';
import { handleStartPairing, handleClaimPairing } from './routes/pairing.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const { pathname } = url;
      const method = request.method.toUpperCase();

      if (method === 'GET' && pathname === '/health') {
        return jsonOk({ ok: true });
      }

      if (method === 'POST' && pathname === '/setup/owner') {
        return await handleSetupOwner(request, env);
      }

      if (method === 'POST' && pathname === '/pairing/start') {
        return await handleStartPairing(request, env);
      }

      if (method === 'POST' && pathname === '/pairing/claim') {
        return await handleClaimPairing(request, env);
      }

      return jsonError('Not Found', 404);
    } catch (error: any) {
      if (error instanceof HttpError) {
        return jsonError(error.message, error.status);
      }
      if (error instanceof z.ZodError) {
        const msg = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return jsonError(msg, 400);
      }
      return jsonError(error?.message || 'Internal Server Error', 500);
    }
  },
};
