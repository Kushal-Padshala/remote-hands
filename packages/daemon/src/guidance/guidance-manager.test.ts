import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GuidanceManager, type GuideStep } from './guidance-manager.js';

describe('GuidanceManager', () => {
  let mockBrowserGuide: any;
  let mockDesktopOverlay: any;
  let manager: GuidanceManager;

  const testSteps: GuideStep[] = [
    { type: 'browser', selector: 'button#new', text: 'Click New' },
    { type: 'browser', selector: 'input#file', text: 'Select File' },
  ];

  beforeEach(() => {
    mockBrowserGuide = {
      show: vi.fn().mockResolvedValue({ success: true }),
      dismiss: vi.fn().mockResolvedValue(undefined),
      checkClicked: vi.fn().mockResolvedValue(false),
    };
    mockDesktopOverlay = {
      show: vi.fn().mockResolvedValue({ success: true }),
      dismiss: vi.fn().mockResolvedValue(undefined),
    };
    const testSessionPath = path.join(
      os.tmpdir(),
      `rh-test-guide-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    manager = new GuidanceManager(mockBrowserGuide, mockDesktopOverlay, testSessionPath);
  });

  it('starts a multi-step guidance session and shows first step', async () => {
    const session = await manager.startSession(testSteps);
    expect(session.active).toBe(true);
    expect(session.currentStepIndex).toBe(0);
    expect(session.steps.length).toBe(2);
    expect(mockBrowserGuide.show).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'button#new', text: 'Click New', step: 1, totalSteps: 2 })
    );
  });

  it('advances to next step smoothly', async () => {
    await manager.startSession(testSteps);
    const nextSession = await manager.next();
    expect(nextSession?.currentStepIndex).toBe(1);
    expect(mockBrowserGuide.show).toHaveBeenCalledTimes(2);
    expect(mockBrowserGuide.show).toHaveBeenLastCalledWith(
      expect.objectContaining({ selector: 'input#file', text: 'Select File', step: 2, totalSteps: 2 })
    );
  });

  it('completes session and dismisses on advancing past last step', async () => {
    await manager.startSession(testSteps);
    await manager.next();
    const finalSession = await manager.next();
    expect(finalSession).toBeNull();
    expect(manager.getStatus()).toBeNull();
    expect(mockBrowserGuide.dismiss).toHaveBeenCalled();
  });

  it('dismisses active session explicitly', async () => {
    await manager.startSession(testSteps);
    await manager.dismiss();
    expect(manager.getStatus()).toBeNull();
    expect(mockBrowserGuide.dismiss).toHaveBeenCalled();
    expect(mockDesktopOverlay.dismiss).toHaveBeenCalled();
  });

  it('throws error when starting session with empty steps', async () => {
    await expect(manager.startSession([])).rejects.toThrow('Guidance session requires at least one step');
  });

  it('handles desktop steps and dismisses browser overlay', async () => {
    const desktopSteps: GuideStep[] = [
      { type: 'desktop', app: 'Finder', target: 'Applications', text: 'Open Applications' },
    ];
    const session = await manager.startSession(desktopSteps);
    expect(session.active).toBe(true);
    expect(mockBrowserGuide.dismiss).toHaveBeenCalled();
    expect(mockDesktopOverlay.show).toHaveBeenCalledWith(
      expect.objectContaining({ app: 'Finder', target: 'Applications', text: 'Open Applications', step: 1, totalSteps: 1 })
    );
  });

  it('navigates to previous step', async () => {
    await manager.startSession(testSteps);
    await manager.next();
    expect(manager.getStatus()?.currentStepIndex).toBe(1);

    const prevSession = await manager.previous();
    expect(prevSession?.currentStepIndex).toBe(0);

    const alreadyAtStart = await manager.previous();
    expect(alreadyAtStart?.currentStepIndex).toBe(0);
  });

  it('returns null when calling next or previous without active session', async () => {
    expect(await manager.next()).toBeNull();
    expect(await manager.previous()).toBeNull();
  });

  it('checks target clicked state for browser step', async () => {
    mockBrowserGuide.checkClicked.mockResolvedValue(true);
    await manager.startSession(testSteps);
    const clicked = await manager.checkTargetClicked();
    expect(clicked).toBe(true);
    expect(mockBrowserGuide.checkClicked).toHaveBeenCalled();
  });

  it('returns false for checkTargetClicked on desktop step or inactive session', async () => {
    expect(await manager.checkTargetClicked()).toBe(false);

    await manager.startSession([
      { type: 'desktop', text: 'Desktop action' }
    ]);
    expect(await manager.checkTargetClicked()).toBe(false);
  });
});
