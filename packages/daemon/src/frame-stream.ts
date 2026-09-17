export interface BrowserFrame {
  jpegBase64: string;
  capturedAt: string;
  width?: number | undefined;
  height?: number | undefined;
}

export interface FrameSource {
  captureFrame(): Promise<BrowserFrame | null>;
}

export interface ThrottledFrameStreamOptions {
  source: FrameSource;
  minIntervalMs?: number | undefined;
  onFrame: (frame: BrowserFrame) => void;
}

export class ThrottledFrameStream {
  private readonly source: FrameSource;
  private readonly minIntervalMs: number;
  private readonly onFrame: (frame: BrowserFrame) => void;

  private lastEmittedAt = 0;
  private lastFrameData: string | null = null;
  private pendingFrame: BrowserFrame | null = null;
  private throttleTimer: any = null;
  private pollTimer: any = null;
  private running = false;

  constructor(options: ThrottledFrameStreamOptions) {
    this.source = options.source;
    this.minIntervalMs = options.minIntervalMs ?? 500;
    this.onFrame = options.onFrame;
  }

  pushFrame(frame: BrowserFrame): boolean {
    const now = Date.now();
    const timeSinceLast = now - this.lastEmittedAt;

    if (frame.jpegBase64 === this.lastFrameData) {
      if (timeSinceLast < 2500) {
        return false;
      }
    }

    if (timeSinceLast >= this.minIntervalMs) {
      this.emit(frame, now);
      return true;
    }

    this.pendingFrame = frame;
    if (!this.throttleTimer) {
      const waitTime = this.minIntervalMs - timeSinceLast;
      this.throttleTimer = setTimeout(() => {
        this.throttleTimer = null;
        if (this.pendingFrame) {
          const toEmit = this.pendingFrame;
          this.pendingFrame = null;
          this.emit(toEmit, Date.now());
        }
      }, waitTime);
    }

    return true;
  }

  private emit(frame: BrowserFrame, timestamp: number): void {
    this.lastEmittedAt = timestamp;
    this.lastFrameData = frame.jpegBase64;
    try {
      this.onFrame(frame);
    } catch {}
  }

  start(pollIntervalMs?: number, options?: { immediate?: boolean }): void {
    if (this.running) return;
    this.running = true;

    const interval = pollIntervalMs ?? this.minIntervalMs;
    const poll = async () => {
      if (!this.running) return;
      try {
        const frame = await this.source.captureFrame();
        if (frame && this.running) {
          this.pushFrame(frame);
        }
      } catch {}

      if (this.running) {
        this.pollTimer = setTimeout(poll, interval);
      }
    };

    if (options?.immediate) {
      poll();
    } else {
      this.pollTimer = setTimeout(poll, interval);
    }
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.pendingFrame = null;
  }
}
