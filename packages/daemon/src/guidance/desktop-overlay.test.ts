import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DesktopOverlayController } from './desktop-overlay.js';

describe('DesktopOverlayController', () => {
  let mockDriver: any;
  let mockAxWalker: any;
  let controller: DesktopOverlayController;

  beforeEach(() => {
    mockDriver = {
      exec: vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 }),
    };
    mockAxWalker = {
      snapshot: vi.fn(),
    };
    controller = new DesktopOverlayController(mockDriver, mockAxWalker);
  });

  it('resolves element bounds via AX walker and renders overlay', async () => {
    mockAxWalker.snapshot.mockResolvedValue({
      app: 'Finder',
      elements: [
        {
          index: 0,
          role: 'AXButton',
          title: 'Upload',
          bounds: { x: 200, y: 150, width: 80, height: 32 },
        },
      ],
    });

    const res = await controller.show({
      app: 'Finder',
      target: 'Upload',
      text: 'Click Upload button',
      step: 1,
    });

    expect(res.success).toBe(true);
    expect(res.bounds).toEqual({ x: 200, y: 150, width: 80, height: 32 });
    expect(mockDriver.exec).toHaveBeenCalled();
  });

  it('uses direct bounds when provided without needing AX lookup', async () => {
    const res = await controller.show({
      bounds: { x: 100, y: 100, width: 50, height: 50 },
      text: 'Target area',
    });

    expect(res.success).toBe(true);
    expect(mockAxWalker.snapshot).not.toHaveBeenCalled();
    expect(mockDriver.exec).toHaveBeenCalled();
  });

  it('dismisses active desktop overlay cleanly', async () => {
    await controller.dismiss();
    expect(mockDriver.exec).toHaveBeenCalled();
  });

  it('matches target by description or label and handles array bounds', async () => {
    mockAxWalker.snapshot.mockResolvedValue({
      app: 'Safari',
      elements: [
        {
          index: 1,
          role: 'AXButton',
          label: 'Submit Order Now',
          bounds: [300, 400, 120, 44],
        },
      ],
    });

    const res = await controller.show({
      app: 'Safari',
      target: 'Submit Order',
      text: 'Confirm and submit',
      step: 2,
      totalSteps: 3,
    });

    expect(res.success).toBe(true);
    expect(res.bounds).toEqual({ x: 300, y: 400, width: 120, height: 44 });
    expect(mockDriver.exec).toHaveBeenCalled();
  });

  it('returns failure when target element is not found', async () => {
    mockAxWalker.snapshot.mockResolvedValue({
      app: 'Finder',
      elements: [],
    });

    const res = await controller.show({
      app: 'Finder',
      target: 'MissingButton',
      text: 'Click missing button',
    });

    expect(res.success).toBe(false);
    expect(res.error).toBe('Target element or bounds not found');
  });

  it('returns failure when neither bounds nor app/target are provided', async () => {
    const res = await controller.show({
      text: 'Nowhere',
    });

    expect(res.success).toBe(false);
    expect(res.error).toBe('Target element or bounds not found');
  });

  it('handles errors thrown by AX walker inspection', async () => {
    mockAxWalker.snapshot.mockRejectedValue(new Error('Permission denied'));

    const res = await controller.show({
      app: 'Finder',
      target: 'Upload',
      text: 'Click Upload button',
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('Failed to inspect app: Permission denied');
  });

  it('instantiates successfully with default constructor dependencies', () => {
    const defaultController = new DesktopOverlayController();
    expect(defaultController).toBeInstanceOf(DesktopOverlayController);
  });
});
