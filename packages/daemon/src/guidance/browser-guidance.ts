import { BrowserDriver } from '../browser-driver.js';
import {
  type GuideOverlayOptions,
  generateShowGuideScript,
  generateDismissGuideScript,
} from './browser-overlay-script.js';

export interface GuideShowResult {
  success: boolean;
  error?: string | undefined;
}

export class BrowserGuidanceController {
  private driver: BrowserDriver;

  constructor(driver?: BrowserDriver) {
    this.driver = driver || new BrowserDriver();
  }

  async show(options: GuideOverlayOptions): Promise<GuideShowResult> {
    const script = generateShowGuideScript(options);
    try {
      const result = await this.driver.executeScript<{ success?: boolean; error?: string }>(script);
      if (result && typeof result === 'object' && result.success === false) {
        return { success: false, error: result.error || 'Failed to highlight target element' };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  }

  async dismiss(): Promise<void> {
    const script = generateDismissGuideScript();
    try {
      await this.driver.executeScript(script);
    } catch {}
  }

  async checkClicked(): Promise<boolean> {
    try {
      const res = await this.driver.executeScript<boolean>(
        'window.__rhGuide ? Boolean(window.__rhGuide.wasClicked()) : false'
      );
      return Boolean(res);
    } catch {
      return false;
    }
  }
}
