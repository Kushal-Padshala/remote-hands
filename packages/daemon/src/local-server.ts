import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import type { LocalTaskStore } from './local-task-store.js';

export interface LocalServerOptions {
  port?: number | undefined;
  host?: string | undefined;
  pairingToken: string;
  store: LocalTaskStore;
  staticDir?: string | undefined;
}

export class LocalServer {
  private server: http.Server;
  private wss: WebSocketServer;
  private options: LocalServerOptions;
  private connections = new Map<string, Set<WebSocket>>();
  public port = 0;

  constructor(options: LocalServerOptions) {
    this.options = options;
    this.server = http.createServer(this.handleHttp.bind(this));
    this.wss = new WebSocketServer({ noServer: true });
    this.setupWebSocket();
  }

  private authenticate(req: http.IncomingMessage, url: URL): boolean {
    const authHeader = req.headers['authorization'];
    let candidate = '';
    if (authHeader && authHeader.startsWith('Bearer ')) {
      candidate = authHeader.slice(7).trim();
    } else if (url.searchParams.has('token')) {
      candidate = (url.searchParams.get('token') ?? '').trim();
    }
    if (!candidate) return false;

    const expectedBuffer = Buffer.from(this.options.pairingToken);
    const candidateBuffer = Buffer.from(candidate);
    if (expectedBuffer.length !== candidateBuffer.length) return false;
    return crypto.timingSafeEqual(expectedBuffer, candidateBuffer);
  }

  private sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    });
    res.end(JSON.stringify(data));
  }

  private readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 10 * 1024 * 1024) {
          req.destroy();
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        if (!data.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        });
        res.end();
        return;
      }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method?.toUpperCase() || 'GET';

    const isApiRoute =
      pathname.startsWith('/api/') ||
      pathname === '/api' ||
      pathname.startsWith('/tasks') ||
      pathname.startsWith('/approvals') ||
      pathname.startsWith('/machines') ||
      pathname === '/status';

    if (isApiRoute) {
      if (!this.authenticate(req, parsedUrl)) {
        this.sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      const apiPath = pathname.startsWith('/api') ? pathname.slice(4) || '/' : pathname;

      if ((apiPath === '/machines' || apiPath.startsWith('/machines')) && method === 'GET') {
        const storedMachine = await (this.options.store.getMachine ? this.options.store.getMachine() : null);
        const machine = storedMachine ?? {
          id: 'primary-machine',
          name: os.hostname(),
          status: 'online',
          lastSeenAt: new Date().toISOString(),
        };
        this.sendJson(res, 200, { machines: [machine] });
        return;
      }

      if (apiPath === '/status' && method === 'GET') {
        this.sendJson(res, 200, { status: 'ok', uptime: process.uptime() });
        return;
      }

      if (apiPath === '/tasks' && method === 'GET') {
        const status = parsedUrl.searchParams.get('status') as any;
        const tasks = await (this.options.store.listTasks ? this.options.store.listTasks({ status }) : []);
        this.sendJson(res, 200, { tasks });
        return;
      }

      if (apiPath === '/tasks' && method === 'POST') {
        try {
          const body = await this.readBody(req);
          const task = await this.options.store.createTask({
            goal: body.goal ?? body.prompt,
            prompt: body.prompt ?? body.goal,
            workspacePath: body.workspacePath ?? body.workspace_path,
            workspace_path: body.workspace_path ?? body.workspacePath,
            userId: body.userId ?? body.user_id,
            user_id: body.user_id ?? body.userId,
            machineId: body.machineId ?? body.machine_id,
            machine_id: body.machine_id ?? body.machineId,
            kind: body.kind,
            mode: body.mode,
            model: body.model,
            effort: body.effort,
          });
          this.broadcast(task.id, {
            type: 'task.event',
            task_id: task.id,
            event: {
              kind: 'status',
              payload: { status: task.status, task_id: task.id },
            },
          });
          this.sendJson(res, 201, { task });
          return;
        } catch (err: any) {
          this.sendJson(res, 400, { error: err?.message || 'Invalid task payload' });
          return;
        }
      }

      const taskMatch = apiPath.match(/^\/tasks\/([^\/]+)$/);
      if (taskMatch && method === 'GET') {
        const taskId = taskMatch[1]!;
        const task = await this.options.store.getTask(taskId);
        if (!task) {
          this.sendJson(res, 404, { error: 'Task not found' });
          return;
        }
        this.sendJson(res, 200, { task });
        return;
      }

      const taskEventsMatch = apiPath.match(/^\/tasks\/([^\/]+)\/events$/);
      if (taskEventsMatch && method === 'GET') {
        const taskId = taskEventsMatch[1]!;
        const events = await this.options.store.getEvents(taskId);
        this.sendJson(res, 200, { events });
        return;
      }

      const taskCancelMatch = apiPath.match(/^\/tasks\/([^\/]+)\/cancel$/);
      if (taskCancelMatch && method === 'POST') {
        const taskId = taskCancelMatch[1]!;
        let body: any = {};
        try {
          body = await this.readBody(req);
        } catch {}
        const task = await (this.options.store.cancelTask ? this.options.store.cancelTask(taskId, body?.reason) : null);
        if (!task) {
          this.sendJson(res, 404, { error: 'Task not found' });
          return;
        }
        this.sendJson(res, 200, { task });
        return;
      }

      const taskApprovalsMatch = apiPath.match(/^\/tasks\/([^\/]+)\/approvals$/);
      if (taskApprovalsMatch && method === 'GET') {
        const taskId = taskApprovalsMatch[1]!;
        const approvals = await this.options.store.listApprovals(taskId);
        this.sendJson(res, 200, { approvals });
        return;
      }

      if (apiPath === '/approvals' && method === 'GET') {
        const taskId = parsedUrl.searchParams.get('taskId') ?? parsedUrl.searchParams.get('task_id') ?? undefined;
        const approvals = await this.options.store.listApprovals(taskId);
        this.sendJson(res, 200, { approvals });
        return;
      }

      const approvalDecisionMatch = apiPath.match(/^\/approvals\/([^\/]+)(?:\/decision)?$/);
      if (approvalDecisionMatch && method === 'POST') {
        const approvalId = approvalDecisionMatch[1]!;
        try {
          const body = await this.readBody(req);
          const decision = body.decision ?? body.status;
          if (decision !== 'approved' && decision !== 'rejected') {
            this.sendJson(res, 400, { error: 'Invalid decision: must be approved or rejected' });
            return;
          }
          const approval = await this.options.store.decideApproval(approvalId, decision, body.reason ?? body.rejectionReason);
          this.broadcast(approval.task_id, {
            type: 'approval.decided',
            approval_id: approvalId,
            decision,
            reason: body.reason,
          });
          this.sendJson(res, 200, { approval });
          return;
        } catch (err: any) {
          this.sendJson(res, 404, { error: err?.message || 'Approval not found' });
          return;
        }
      }

      const getApprovalMatch = apiPath.match(/^\/approvals\/([^\/]+)$/);
      if (getApprovalMatch && method === 'GET') {
        const approvalId = getApprovalMatch[1]!;
        const approval = await this.options.store.getApproval(approvalId);
        if (!approval) {
          this.sendJson(res, 404, { error: 'Approval not found' });
          return;
        }
        this.sendJson(res, 200, { approval });
        return;
      }

      if (pathname.startsWith('/api/') || pathname === '/api') {
        this.sendJson(res, 404, { error: 'Not found' });
        return;
      }
    }

    if (this.options.staticDir && fs.existsSync(this.options.staticDir)) {
      if (req.url?.includes('..') || pathname.includes('..')) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      let safePathname: string;
      try {
        safePathname = decodeURIComponent(pathname);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
        return;
      }

      if (safePathname.includes('..')) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      const staticDir = path.resolve(this.options.staticDir);
      let relativePath = safePathname === '/' ? 'index.html' : safePathname;
      if (relativePath.startsWith('/')) {
        relativePath = relativePath.slice(1);
      }
      const targetPath = path.resolve(staticDir, relativePath);
      const isInsideStatic = targetPath === staticDir || targetPath.startsWith(staticDir + path.sep);

      if (!isInsideStatic) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      if (fs.existsSync(targetPath)) {
        const stat = fs.statSync(targetPath);
        if (!stat.isDirectory()) {
          const ext = path.extname(targetPath).toLowerCase();
          const mimeTypes: Record<string, string> = {
            '.html': 'text/html; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.mjs': 'application/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
            '.webp': 'image/webp',
            '.wasm': 'application/wasm',
            '.txt': 'text/plain; charset=utf-8',
          };
          const contentType = mimeTypes[ext] || 'application/octet-stream';
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stat.size,
          });
          fs.createReadStream(targetPath).pipe(res);
          return;
        }
      }

      const indexPath = path.join(staticDir, 'index.html');
      if (fs.existsSync(indexPath) && !path.extname(safePathname)) {
        const stat = fs.statSync(indexPath);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': stat.size,
        });
        fs.createReadStream(indexPath).pipe(res);
        return;
      }

      if (path.extname(safePathname)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Remote Hands Local Daemon');
    } catch (err: any) {
      if (!res.headersSent) {
        this.sendJson(res, 500, { error: 'Internal server error', message: err?.message || String(err) });
      }
    }
  }

  private setupWebSocket(): void {
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (!this.authenticate(req, url)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      if (!url.pathname.startsWith('/ws/tasks/')) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const taskId = url.pathname.slice('/ws/tasks/'.length);
        if (!this.connections.has(taskId)) {
          this.connections.set(taskId, new Set());
        }
        this.connections.get(taskId)!.add(ws);

        ws.on('message', (raw) => {
          try {
            const text = typeof raw === 'string' ? raw : raw.toString();
            const parsed = JSON.parse(text);
            if (parsed.type === 'ping') {
              ws.send(JSON.stringify({ type: 'pong' }));
            }
          } catch {}
        });

        ws.on('close', () => {
          const clients = this.connections.get(taskId);
          if (clients) {
            clients.delete(ws);
            if (clients.size === 0) {
              this.connections.delete(taskId);
            }
          }
        });
      });
    });
  }

  broadcast(taskId: string, message: unknown): void {
    const clients = this.connections.get(taskId);
    if (!clients) return;
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  broadcastFrame(
    taskId: string,
    frame: { jpegBase64?: string; jpeg_base64?: string; capturedAt?: string; captured_at?: string },
  ): void {
    const jpeg_base64 = frame.jpeg_base64 ?? frame.jpegBase64 ?? '';
    const captured_at = frame.captured_at ?? frame.capturedAt ?? new Date().toISOString();
    this.broadcast(taskId, {
      type: 'task.frame',
      task_id: taskId,
      jpeg_base64,
      captured_at,
    });
  }

  async pushFrame(
    taskId: string,
    frame: { jpegBase64: string; capturedAt: string },
  ): Promise<void> {
    if (typeof this.options.store.pushFrame === 'function') {
      await this.options.store.pushFrame(taskId, frame);
    }
    this.broadcastFrame(taskId, frame);
  }

  broadcastEvent(taskId: string, event: unknown): void {
    this.broadcast(taskId, {
      type: 'task.event',
      task_id: taskId,
      event,
    });
  }

  getConnectedClientCount(taskId?: string): number {
    if (taskId) {
      return this.connections.get(taskId)?.size ?? 0;
    }
    let total = 0;
    for (const set of this.connections.values()) {
      total += set.size;
    }
    return total;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port ?? 3000, this.options.host ?? '0.0.0.0', () => {
        this.server.removeListener('error', reject);
        const addr = this.server.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        } else {
          this.port = this.options.port ?? 3000;
        }
        resolve(this.port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const [, clients] of this.connections) {
        for (const ws of clients) {
          try {
            ws.terminate();
          } catch {}
        }
      }
      this.connections.clear();

      this.wss.close(() => {
        this.server.close(() => resolve());
        if (typeof (this.server as any).closeAllConnections === 'function') {
          (this.server as any).closeAllConnections();
        }
      });
    });
  }
}
