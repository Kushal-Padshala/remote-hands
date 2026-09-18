import { z } from 'zod';
import type { Env } from './env.js';
import { TaskRoom } from './durable-objects/task-room.js';
export { TaskRoom };
import { HttpError } from './http/errors.js';
import { jsonError, jsonOk, corsHeaders } from './http/json.js';
import { handleSetupOwner } from './routes/setup.js';
import { handleStartPairing, handleClaimPairing, handleCreatePhoneSession } from './routes/pairing.js';
import { handleListMachines, handleGetMachine, handleMachineHeartbeat } from './routes/machines.js';
import {
  handleListTasks,
  handleCreateTask,
  handleClaimNextTask,
  handleGetTask,
  handleClaimTask,
  handleMarkTaskRunning,
  handleMarkTaskAwaitingApproval,
  handleCompleteTask,
  handleFailTask,
  handleCancelTask,
} from './routes/tasks.js';
import { handleListEvents, handleAppendEvent } from './routes/events.js';
import { handlePushFrame } from './routes/frames.js';
import { handleCreateApproval, handleDecideApproval, handleGetApproval, handleListTaskApprovals } from './routes/approvals.js';
import { handleTaskWebSocket, handleMachineWebSocket } from './routes/websocket.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const { pathname } = url;
      const method = request.method.toUpperCase();

      if (method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: corsHeaders,
        });
      }

      if (method === 'GET' && pathname === '/health') {
        return jsonOk({ ok: true });
      }

      if (pathname.startsWith('/ws/tasks/')) {
        const taskId = pathname.slice('/ws/tasks/'.length);
        return await handleTaskWebSocket(taskId, request, env);
      }

      if (pathname.startsWith('/ws/machines/')) {
        const machineId = pathname.slice('/ws/machines/'.length);
        return await handleMachineWebSocket(machineId, request, env);
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

      if (method === 'POST' && pathname === '/pairing/phone-session') {
        return await handleCreatePhoneSession(request, env);
      }

      if (method === 'GET' && pathname === '/machines') {
        return await handleListMachines(request, env);
      }

      const machineSubrouteMatch = pathname.match(/^\/machines\/([a-zA-Z0-9_-]+)(?:\/(.*))?$/);
      if (machineSubrouteMatch) {
        const machineId = machineSubrouteMatch[1]!;
        const subaction = machineSubrouteMatch[2];
        if (!subaction && method === 'GET') {
          return await handleGetMachine(machineId, request, env);
        }
        if (subaction === 'heartbeat' && method === 'POST') {
          return await handleMachineHeartbeat(machineId, request, env);
        }
      }

      if (method === 'GET' && pathname === '/tasks') {
        return await handleListTasks(request, env);
      }

      if (method === 'POST' && pathname === '/tasks') {
        return await handleCreateTask(request, env);
      }

      if (method === 'POST' && pathname === '/tasks/claim') {
        return await handleClaimNextTask(request, env);
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
        if (subaction === 'awaiting_approval' && method === 'POST') {
          return await handleMarkTaskAwaitingApproval(taskId, request, env);
        }
        if (subaction === 'complete' && method === 'POST') {
          return await handleCompleteTask(taskId, request, env);
        }
        if (subaction === 'fail' && method === 'POST') {
          return await handleFailTask(taskId, request, env);
        }
        if (subaction === 'cancel' && method === 'POST') {
          return await handleCancelTask(taskId, request, env);
        }
        if (subaction === 'events' && method === 'GET') {
          return await handleListEvents(taskId, request, env);
        }
        if (subaction === 'events' && method === 'POST') {
          return await handleAppendEvent(taskId, request, env);
        }
        if (subaction === 'approvals' && method === 'GET') {
          return await handleListTaskApprovals(taskId, request, env);
        }
        if ((subaction === 'frames' || subaction === 'frame') && method === 'POST') {
          return await handlePushFrame(taskId, request, env);
        }
      }

      if (method === 'POST' && pathname === '/approvals') {
        return await handleCreateApproval(request, env);
      }

      const approvalGetMatch = pathname.match(/^\/approvals\/([a-zA-Z0-9_-]+)$/);
      if (approvalGetMatch && method === 'GET') {
        const approvalId = approvalGetMatch[1]!;
        return await handleGetApproval(approvalId, request, env);
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
