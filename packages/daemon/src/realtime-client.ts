import {
  safeParseRealtimeMessage,
  REALTIME_PROTOCOL_VERSION,
  type RealtimeMessage,
} from '@remote-hands/shared';

export interface RealtimeClientConfig {
  baseUrl: string;
  sessionToken: string;
  reconnect?: boolean | undefined;
  baseBackoffMs?: number | undefined;
  maxBackoffMs?: number | undefined;
  webSocketFactory?: ((url: string) => any) | undefined;
}

export class RealtimeClient {
  private readonly baseUrl: string;
  private readonly sessionToken: string;
  private readonly reconnect: boolean;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly webSocketFactory: (url: string) => any;

  private ws: any = null;
  private currentUrl: string | null = null;
  private closed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: any = null;
  private messageHandlers = new Set<(message: RealtimeMessage) => void>();
  private pendingQueue: string[] = [];

  constructor(config: RealtimeClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.sessionToken = config.sessionToken;
    this.reconnect = config.reconnect ?? true;
    this.baseBackoffMs = config.baseBackoffMs ?? 1000;
    this.maxBackoffMs = config.maxBackoffMs ?? 30000;
    this.webSocketFactory =
      config.webSocketFactory ?? ((url: string) => new (globalThis as any).WebSocket(url));
  }

  private buildWsUrl(subpath: string): string {
    const parsed = new URL(this.baseUrl);
    const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    const cleanPath = subpath.startsWith('/') ? subpath : `/${subpath}`;
    return `${protocol}//${parsed.host}${cleanPath}?token=${encodeURIComponent(this.sessionToken)}`;
  }

  async connectMachine(machineId: string): Promise<void> {
    const url = this.buildWsUrl(`/ws/machines/${machineId}`);
    await this.connectUrl(url);
  }

  async connectTask(taskId: string): Promise<void> {
    const url = this.buildWsUrl(`/ws/tasks/${taskId}`);
    await this.connectUrl(url);
  }

  private connectUrl(url: string): Promise<void> {
    this.currentUrl = url;
    this.closed = false;

    return new Promise<void>((resolve, reject) => {
      let resolved = false;

      try {
        const ws = this.webSocketFactory(url);
        this.ws = ws;

        const onOpen = () => {
          this.reconnectAttempts = 0;
          this.sendRaw({ type: 'hello', role: 'daemon', protocol_version: REALTIME_PROTOCOL_VERSION });

          while (this.pendingQueue.length > 0) {
            const item = this.pendingQueue.shift()!;
            try {
              ws.send(item);
            } catch {}
          }

          if (!resolved) {
            resolved = true;
            resolve();
          }
        };

        const onMessage = (event: any) => {
          const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(raw);
          } catch {
            return;
          }

          const res = safeParseRealtimeMessage(parsedJson);
          if (!res.ok) return;

          for (const handler of this.messageHandlers) {
            try {
              handler(res.message);
            } catch {}
          }
        };

        const onClose = () => {
          if (this.ws === ws) {
            this.ws = null;
          }
          if (!this.closed && this.reconnect && this.currentUrl) {
            this.scheduleReconnect();
          }
        };

        const onError = (err: any) => {
          if (!resolved) {
            resolved = true;
            reject(err);
          }
          if (!this.closed && this.reconnect && this.currentUrl) {
            this.scheduleReconnect();
          }
        };

        if (typeof ws.addEventListener === 'function') {
          ws.addEventListener('open', onOpen);
          ws.addEventListener('message', onMessage);
          ws.addEventListener('close', onClose);
          ws.addEventListener('error', onError);
        } else {
          ws.onopen = onOpen;
          ws.onmessage = onMessage;
          ws.onclose = onClose;
          ws.onerror = onError;
        }
      } catch (err) {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const backoff = Math.min(
      this.maxBackoffMs,
      this.baseBackoffMs * 2 ** this.reconnectAttempts + Math.random() * Math.min(500, this.baseBackoffMs),
    );
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed && this.currentUrl) {
        this.connectUrl(this.currentUrl).catch(() => {});
      }
    }, backoff);
  }

  send(message: RealtimeMessage): void {
    this.sendRaw(message);
  }

  private sendRaw(data: unknown): void {
    const payload = JSON.stringify(data);
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(payload);
    } else {
      this.pendingQueue.push(payload);
    }
  }

  onMessage(handler: (message: RealtimeMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.messageHandlers.clear();
    this.pendingQueue = [];
  }
}
