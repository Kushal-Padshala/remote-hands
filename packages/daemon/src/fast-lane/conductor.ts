import type { SkillRegistry } from './skills/registry.js';
import type { Skill, SkillContext, Slots } from './skills/types.js';
import type { DecisionEngine } from './types.js';

export type Route =
  | { lane: 'skill'; skill: Skill; slots: Slots }
  | { lane: 'pilot'; gapNats: number }
  | { lane: 'brain'; reason: string };

export interface RouteInput {
  query: string;
  frontApp: string;
  frontIsBrowser: boolean;
  registry: SkillRegistry;
  ctx: SkillContext;
  engine: DecisionEngine;
  /** Below this gap between the two options the model is not sure and the brain takes over. */
  handoffGapNats: number;
}

const PILOT_TEXT = 'Operate the web page in front of me: click, fill in forms, move through pages.';
const BRAIN_TEXT = 'Something else: write text, research, run code, answer a question, or use another app.';

/**
 * Decides who handles a request. Instant skills are matched first by strict patterns (no model
 * call, no latency); a web page in front gets one decision between the pilot and the brain;
 * everything else, and every doubt, goes to the brain.
 */
export async function routeRequest(input: RouteInput): Promise<Route> {
  const matched = await input.registry.match(input.query, input.ctx);
  if (matched !== null) return { lane: 'skill', skill: matched.skill, slots: matched.slots };

  if (!input.frontIsBrowser) return { lane: 'brain', reason: 'no web page is in front' };

  try {
    const answer = await input.engine.decide({
      state: `User request: "${input.query.trim()}"\nFrontmost application: ${input.frontApp} (a web browser)`,
      question: 'What should be done with this request?',
      options: [
        { id: 'pilot', text: PILOT_TEXT },
        { id: 'brain', text: BRAIN_TEXT },
      ],
    });
    if (answer.choice === null) return { lane: 'brain', reason: 'the local model made no choice' };
    if (answer.choice === 'brain') return { lane: 'brain', reason: 'the request needs more than page actions' };
    if (answer.gapNats < input.handoffGapNats) {
      return { lane: 'brain', reason: `the local model was not sure (gap ${answer.gapNats.toFixed(2)} nats)` };
    }
    return { lane: 'pilot', gapNats: answer.gapNats };
  } catch (err) {
    return { lane: 'brain', reason: `the local model is unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}
