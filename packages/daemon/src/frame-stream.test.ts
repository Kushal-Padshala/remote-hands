import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  ThrottledFrameStream,
  type BrowserFrame,
  type FrameSource,
} from './frame-stream.js';

describe('ThrottledFrameStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops identical consecutive frames', () => {
    const emitted: BrowserFrame[] = [];
    const dummySource: FrameSource = {
      captureFrame: vi.fn(async () => null),
    };

    const stream = new ThrottledFrameStream({
      source: dummySource,
      minIntervalMs: 500,
      onFrame: (frame) => emitted.push(frame),
    });

    const frame1: BrowserFrame = {
      jpegBase64: 'data:image/jpeg;base64,AAAA',
      capturedAt: new Date().toISOString(),
    };

    const frame2: BrowserFrame = {
      jpegBase64: 'data:image/jpeg;base64,AAAA',
      capturedAt: new Date().toISOString(),
    };

    const accepted1 = stream.pushFrame(frame1);
    const accepted2 = stream.pushFrame(frame2);

    expect(accepted1).toBe(true);
    expect(accepted2).toBe(false);
    expect(emitted.length).toBe(1);
  });

  it('throttles frames arriving faster than minIntervalMs', () => {
    const emitted: BrowserFrame[] = [];
    const dummySource: FrameSource = {
      captureFrame: vi.fn(async () => null),
    };

    const stream = new ThrottledFrameStream({
      source: dummySource,
      minIntervalMs: 500,
      onFrame: (frame) => emitted.push(frame),
    });

    stream.pushFrame({
      jpegBase64: 'frame-1',
      capturedAt: new Date().toISOString(),
    });
    expect(emitted.length).toBe(1);

    vi.advanceTimersByTime(100);
    stream.pushFrame({
      jpegBase64: 'frame-2',
      capturedAt: new Date().toISOString(),
    });
    expect(emitted.length).toBe(1);

    vi.advanceTimersByTime(100);
    stream.pushFrame({
      jpegBase64: 'frame-3',
      capturedAt: new Date().toISOString(),
    });
    expect(emitted.length).toBe(1);

    vi.advanceTimersByTime(300);
    expect(emitted.length).toBe(2);
    expect(emitted[1]!.jpegBase64).toBe('frame-3');

    vi.advanceTimersByTime(500);
    stream.pushFrame({
      jpegBase64: 'frame-4',
      capturedAt: new Date().toISOString(),
    });
    expect(emitted.length).toBe(3);
    expect(emitted[2]!.jpegBase64).toBe('frame-4');
  });

  it('polls frame source during active capture lifecycle', async () => {
    const emitted: BrowserFrame[] = [];
    let counter = 0;
    const mockSource: FrameSource = {
      captureFrame: vi.fn(async () => {
        counter++;
        return {
          jpegBase64: `frame-${counter}`,
          capturedAt: new Date().toISOString(),
        };
      }),
    };

    const stream = new ThrottledFrameStream({
      source: mockSource,
      minIntervalMs: 500,
      onFrame: (frame) => emitted.push(frame),
    });

    stream.start(500);

    await vi.advanceTimersByTimeAsync(500);
    expect(emitted.length).toBe(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(emitted.length).toBe(2);

    stream.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(emitted.length).toBe(2);
  });
});
