import {
  safeParseRealtimeMessage,
  type RealtimeMessage,
} from '@remote-hands/shared';
import type { Env } from '../env.js';

export interface ClientMeta {
  role?: 'phone' | 'daemon' | undefined;
}


export class TaskRoom {
  private clients = new Map<any, ClientMeta>();

  constructor(
    private state: any,
    private env: Env,
  ) {}

  handleConnection(ws: any, defaultRole?: 'phone' | 'daemon'): void {
    this.clients.set(ws, { role: defaultRole });
  }

  handleClose(ws: any): void {
    this.clients.delete(ws);
  }

  async handleMessage(ws: any, rawData: string | ArrayBuffer): Promise<void> {
    const text = typeof rawData === 'string' ? rawData : new TextDecoder().decode(rawData);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      this.sendError(ws, 'Malformed JSON payload');
      return;
    }

    const parseResult = safeParseRealtimeMessage(parsedJson);
    if (!parseResult.ok) {
      this.sendError(ws, `Invalid realtime message: ${parseResult.error}`);
      return;
    }

    const message = parseResult.message;
    const clientMeta = this.clients.get(ws) ?? {};

    if (message.type === 'hello') {
      clientMeta.role = message.role;
      this.clients.set(ws, clientMeta);
      return;
    }

    this.relayMessage(ws, message);
  }

  private sendError(ws: any, message: string): void {
    try {
      ws.send(JSON.stringify({ type: 'error', message }));
    } catch {}
  }

  private relayMessage(senderWs: any, message: RealtimeMessage): void {
    const payload = JSON.stringify(message);

    for (const [clientWs, meta] of this.clients.entries()) {
      if (clientWs === senderWs) continue;

      if (message.type === 'task.event' || message.type === 'task.frame' || message.type === 'approval.requested') {
        if (!meta.role || meta.role === 'phone') {
          try {
            clientWs.send(payload);
          } catch {}
        }
      } else if (message.type === 'approval.decided') {
        if (!meta.role || meta.role === 'daemon') {
          try {
            clientWs.send(payload);
          } catch {}
        }
      } else {
        try {
          clientWs.send(payload);
        } catch {}
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const pair = new (globalThis as any).WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    if (this.state && typeof this.state.acceptWebSocket === 'function') {
      this.state.acceptWebSocket(server);
      this.handleConnection(server);
    } else if (typeof server.accept === 'function') {
      server.accept();
      this.handleConnection(server);
      server.addEventListener('message', (event: any) => {
        this.handleMessage(server, event.data);
      });
      server.addEventListener('close', () => {
        this.handleClose(server);
      });
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as any);

  }

  async webSocketMessage(ws: any, message: string | ArrayBuffer): Promise<void> {
    await this.handleMessage(ws, message);
  }

  async webSocketClose(ws: any): Promise<void> {
    this.handleClose(ws);
  }
}
