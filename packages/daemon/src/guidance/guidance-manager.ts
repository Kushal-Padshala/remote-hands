import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BrowserGuidanceController } from './browser-guidance.js';
import { DesktopOverlayController, type DesktopBounds } from './desktop-overlay.js';

export interface GuideStep {
  type: 'browser' | 'desktop';
  selector?: string | undefined;
  index?: number | undefined;
  app?: string | undefined;
  target?: string | undefined;
  bounds?: DesktopBounds | undefined;
  text: string;
}

export interface GuidanceSession {
  id: string;
  currentStepIndex: number;
  steps: GuideStep[];
  active: boolean;
}

export class GuidanceManager {
  private browserGuide: BrowserGuidanceController;
  private desktopOverlay: DesktopOverlayController;
  private currentSession: GuidanceSession | null = null;
  private sessionFilePath: string;

  constructor(
    browserGuide?: BrowserGuidanceController,
    desktopOverlay?: DesktopOverlayController,
    sessionFilePath?: string
  ) {
    this.browserGuide = browserGuide || new BrowserGuidanceController();
    this.desktopOverlay = desktopOverlay || new DesktopOverlayController();
    this.sessionFilePath =
      sessionFilePath ||
      path.join(os.homedir(), '.remote-hands', 'guidance-session.json');
  }

  private loadSession(): void {
    if (this.currentSession) return;
    try {
      if (fs.existsSync(this.sessionFilePath)) {
        const raw = fs.readFileSync(this.sessionFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.active) {
          this.currentSession = parsed as GuidanceSession;
        }
      }
    } catch {}
  }

  private saveSession(): void {
    if (!this.currentSession) {
      try {
        if (fs.existsSync(this.sessionFilePath)) {
          fs.unlinkSync(this.sessionFilePath);
        }
      } catch {}
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.sessionFilePath), { recursive: true });
      fs.writeFileSync(
        this.sessionFilePath,
        JSON.stringify(this.currentSession, null, 2),
        'utf-8'
      );
    } catch {}
  }

  async startSession(steps: GuideStep[]): Promise<GuidanceSession> {
    if (steps.length === 0) {
      throw new Error('Guidance session requires at least one step');
    }
    await this.dismiss();

    this.currentSession = {
      id: `guide-${Date.now()}`,
      currentStepIndex: 0,
      steps,
      active: true,
    };

    this.saveSession();
    await this.renderCurrentStep();
    return this.currentSession;
  }

  private async renderCurrentStep(): Promise<void> {
    this.loadSession();
    if (!this.currentSession || !this.currentSession.active) return;
    const step = this.currentSession.steps[this.currentSession.currentStepIndex];
    if (!step) return;

    const stepNum = this.currentSession.currentStepIndex + 1;
    const total = this.currentSession.steps.length;

    if (step.type === 'browser') {
      await this.desktopOverlay.dismiss();
      await this.browserGuide.show({
        selector: step.selector,
        index: step.index,
        text: step.text,
        step: stepNum,
        totalSteps: total,
      });
    } else {
      await this.browserGuide.dismiss();
      await this.desktopOverlay.show({
        app: step.app,
        target: step.target,
        bounds: step.bounds,
        text: step.text,
        step: stepNum,
        totalSteps: total,
      });
    }
  }

  async next(): Promise<GuidanceSession | null> {
    this.loadSession();
    if (!this.currentSession || !this.currentSession.active) return null;
    this.currentSession.currentStepIndex++;
    if (this.currentSession.currentStepIndex >= this.currentSession.steps.length) {
      await this.dismiss();
      return null;
    }
    this.saveSession();
    await this.renderCurrentStep();
    return this.currentSession;
  }

  async previous(): Promise<GuidanceSession | null> {
    this.loadSession();
    if (!this.currentSession || !this.currentSession.active) return null;
    if (this.currentSession.currentStepIndex <= 0) {
      return this.currentSession;
    }
    this.currentSession.currentStepIndex--;
    this.saveSession();
    await this.renderCurrentStep();
    return this.currentSession;
  }

  async dismiss(): Promise<void> {
    this.currentSession = null;
    this.saveSession();
    await Promise.all([
      this.browserGuide.dismiss(),
      this.desktopOverlay.dismiss(),
    ]);
  }

  getStatus(): GuidanceSession | null {
    this.loadSession();
    return this.currentSession;
  }

  async checkTargetClicked(): Promise<boolean> {
    this.loadSession();
    if (!this.currentSession || !this.currentSession.active) return false;
    const step = this.currentSession.steps[this.currentSession.currentStepIndex];
    if (!step || step.type !== 'browser') return false;
    return await this.browserGuide.checkClicked();
  }
}
