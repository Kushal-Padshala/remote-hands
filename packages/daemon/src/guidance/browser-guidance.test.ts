import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserGuidanceController } from './browser-guidance.js';

describe('BrowserGuidanceController', () => {
  let mockDriver: any;
  let controller: BrowserGuidanceController;

  beforeEach(() => {
    mockDriver = {
      executeScript: vi.fn(),
    };
    controller = new BrowserGuidanceController(mockDriver);
  });

  it('invokes driver executeScript with generated show script', async () => {
    mockDriver.executeScript.mockResolvedValue({ success: true });
    const res = await controller.show({
      selector: 'button#submit',
      text: 'Submit form',
      step: 1,
      totalSteps: 2,
    });
    expect(res.success).toBe(true);
    expect(mockDriver.executeScript).toHaveBeenCalledTimes(1);
    expect(mockDriver.executeScript.mock.calls[0][0]).toContain('window.__rhGuide.show');
    expect(mockDriver.executeScript.mock.calls[0][0]).toContain('button#submit');
  });

  it('handles show error when element is not found', async () => {
    mockDriver.executeScript.mockResolvedValue({
      success: false,
      error: 'Target element not found',
    });
    const res = await controller.show({
      selector: 'button#missing',
      text: 'Missing button',
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe('Target element not found');
  });

  it('handles show exception from driver executeScript', async () => {
    mockDriver.executeScript.mockRejectedValue(new Error('CDP evaluation failed'));
    const res = await controller.show({
      selector: 'button#err',
      text: 'Error button',
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe('CDP evaluation failed');
  });

  it('invokes driver executeScript for dismiss', async () => {
    mockDriver.executeScript.mockResolvedValue({ success: true });
    await controller.dismiss();
    expect(mockDriver.executeScript).toHaveBeenCalledTimes(1);
    expect(mockDriver.executeScript.mock.calls[0][0]).toContain('window.__rhGuide.dismiss');
  });

  it('handles dismiss gracefully when driver throws', async () => {
    mockDriver.executeScript.mockRejectedValue(new Error('Connection closed'));
    await expect(controller.dismiss()).resolves.toBeUndefined();
  });

  it('checks if target element was clicked by user', async () => {
    mockDriver.executeScript.mockResolvedValue(true);
    const clicked = await controller.checkClicked();
    expect(clicked).toBe(true);
    expect(mockDriver.executeScript.mock.calls[0][0]).toContain('window.__rhGuide.wasClicked()');
  });

  it('returns false from checkClicked when driver throws', async () => {
    mockDriver.executeScript.mockRejectedValue(new Error('Timeout'));
    const clicked = await controller.checkClicked();
    expect(clicked).toBe(false);
  });

  it('constructs with default driver if none provided', () => {
    const defaultController = new BrowserGuidanceController();
    expect(defaultController).toBeInstanceOf(BrowserGuidanceController);
  });
});
