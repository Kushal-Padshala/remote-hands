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

// Phrased as a yes/no about the page the user is looking at: the earlier "pilot or something else"
// wording sent 10 of 12 ordinary page tasks to the brain (measured), this one sends 11 of 12 to the pilot.
const PILOT_TEXT = 'Yes: it is about clicking, filling in or moving through the web page that is open.';
const BRAIN_TEXT = 'No: it is about writing, researching, coding, answering a question or another app.';

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
      state: `User request: "${input.query.trim()}"\nThe user is looking at a web page in ${input.frontApp} right now.`,
      question: 'Is this request about doing things on the web page the user is looking at?',
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
