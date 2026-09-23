import { SpotlightHudRunner, type SpotlightPromptResult } from '../desktop/spotlight-hud.js';
import { IntentResolver } from './intent-resolver.js';
import { GuidanceManager } from './guidance-manager.js';

export class HudCoordinator {
  private hudRunner: SpotlightHudRunner;
  private intentResolver: IntentResolver;
  private guidanceManager: GuidanceManager;

  constructor(
    hudRunner?: SpotlightHudRunner,
    intentResolver?: IntentResolver,
    guidanceManager?: GuidanceManager
  ) {
    this.hudRunner = hudRunner || new SpotlightHudRunner();
    this.intentResolver = intentResolver || new IntentResolver();
    this.guidanceManager = guidanceManager || new GuidanceManager();
  }

  async triggerPrompt(appOverride?: string): Promise<boolean> {
    const promptResult = await this.hudRunner.openPrompt(appOverride);
    if (!promptResult || !promptResult.query) {
      return false;
    }

    const resolution = await this.intentResolver.resolve(
      promptResult.query,
      promptResult.app
    );

    if (resolution.steps.length === 0) {
      return false;
    }

    await this.guidanceManager.startSession(resolution.steps);
    return true;
  }

  startListening(): { stop: () => void } {
    return this.hudRunner.startListener(async (result: SpotlightPromptResult) => {
      try {
        const resolution = await this.intentResolver.resolve(result.query, result.app);
        if (resolution.steps.length > 0) {
          await this.guidanceManager.startSession(resolution.steps);
        }
      } catch {}
    });
  }
}
