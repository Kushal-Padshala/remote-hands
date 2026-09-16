import { z } from 'zod';
import type { Env } from './env.js';
import { HttpError } from './http/errors.js';
import { jsonError, jsonOk } from './http/json.js';
import { handleSetupOwner } from './routes/setup.js';
import { handleStartPairing, handleClaimPairing } from './routes/pairing.js';
import { handleListMachines } from './routes/machines.js';
import {
  handleCreateTask,
  handleGetTask,
  handleClaimTask,
  handleMarkTaskRunning,
  handleCompleteTask,
  handleFailTask,
} from './routes/tasks.js';

import { handleListEvents, handleAppendEvent } from './routes/events.js';
import { handleCreateApproval, handleDecideApproval } from './routes/approvals.js';

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

      if (method === 'GET' && pathname === '/machines') {
        return await handleListMachines(request, env);
      }

      if (method === 'POST' && pathname === '/tasks') {
        return await handleCreateTask(request, env);
      }

      const taskSubrouteMatch = pathname.match(/^\/tasks\/([a-zA-Z0-9_-]+)(?:\/(.*))?$/);
      if (taskSubrouteMatch) {
        const taskId = taskSubrouteMatch[1]!;
        const subaction = taskSubrouteMatch[2];

        if (!subaction && method === 'GET') {
          return await handleGetTask(taskId, request, env);
        }
        if (subaction === 'claim' && method === 'POST') {
          return await handleClaimTask(taskId, request, env);
        }
        if (subaction === 'running' && method === 'POST') {
          return await handleMarkTaskRunning(taskId, request, env);
        }
        if (subaction === 'complete' && method === 'POST') {

          return await handleCompleteTask(taskId, request, env);
        }
        if (subaction === 'fail' && method === 'POST') {
          return await handleFailTask(taskId, request, env);
        }
        if (subaction === 'events' && method === 'GET') {
          return await handleListEvents(taskId, request, env);
        }
        if (subaction === 'events' && method === 'POST') {
          return await handleAppendEvent(taskId, request, env);
        }
      }

      if (method === 'POST' && pathname === '/approvals') {
        return await handleCreateApproval(request, env);
      }

      const approvalDecisionMatch = pathname.match(/^\/approvals\/([a-zA-Z0-9_-]+)\/decision$/);
      if (approvalDecisionMatch && method === 'POST') {
        const approvalId = approvalDecisionMatch[1]!;
        return await handleDecideApproval(approvalId, request, env);
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
