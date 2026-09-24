import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpotlightHudRunner } from './spotlight-hud.js';

describe('SpotlightHudRunner', () => {
  let mockExec: any;
  let runner: SpotlightHudRunner;

  beforeEach(() => {
    mockExec = vi.fn();
    runner = new SpotlightHudRunner(mockExec);
  });

  it('parses successful prompt response from swift hud', async () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify({ query: 'how to upload a new file', app: 'Photoshop' }),
      stderr: '',
      status: 0,
    });

    const result = await runner.openPrompt('Photoshop');
    expect(result).toEqual({ query: 'how to upload a new file', app: 'Photoshop' });
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringMatching(/swift|rh-spotlight/),
      expect.arrayContaining(['prompt', '--app=Photoshop'])
    );
  });

  it('returns null when user cancels prompt or exits with non-zero status', async () => {
    mockExec.mockReturnValue({
      stdout: '',
      stderr: 'cancelled',
      status: 1,
    });

    const result = await runner.openPrompt();
    expect(result).toBeNull();
  });

  it('handles invalid json output gracefully', async () => {
    mockExec.mockReturnValue({
      stdout: 'not a json',
      stderr: '',
      status: 0,
    });

    const result = await runner.openPrompt();
    expect(result).toBeNull();
  });

  it('exposes openInteractivePrompt method returning a close handle', () => {
    const handle = runner.openInteractivePrompt('Finder', () => {});
    expect(handle).toBeDefined();
    expect(typeof handle.close).toBe('function');
    handle.close();
  });

  it('triggers onCancel when handle.close is invoked', () => {
    const onCancel = vi.fn();
    const handle = runner.openInteractivePrompt('Finder', () => {}, onCancel);
    handle.close();
    expect(onCancel).toHaveBeenCalled();
  });
});
