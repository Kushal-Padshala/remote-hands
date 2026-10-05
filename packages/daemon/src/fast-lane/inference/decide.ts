import type { DecideInput, DecideResult, DecisionEngine } from '../types.js';
import type { PromptFormat } from './catalog.js';
import type { LlamaSidecar } from './server.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234';
/** Below this probability mass on the option letters the model made no usable decision. */
export const MIN_LETTER_MASS = 0.5;
// Untrusted text is capped so one long page cannot overflow the 4096-token context.
const MAX_STATE_CHARS = 6000;
const MAX_QUESTION_CHARS = 600;
const MAX_OPTION_CHARS = 240;
const MAX_SYSTEM_CHARS = 600;
const DEFAULT_TIMEOUT_MS = 15_000;

const DEFAULT_SYSTEM =
  'You are a decision engine. Read the state and the question, then answer with exactly one option letter and nothing else.';

/**
 * Page text and window titles are untrusted. llama-server parses special tokens inside prompt text,
 * so anything that looks like a chat-template or tool token is defanged before it can end our turn
 * and start a fake system message.
 */
function sanitize(text: string): string {
  return text
    .replace(/<\|/g, '< |')
    .replace(/\|>/g, '| >')
    .replace(/<(\/?)(think|tool_call|tool_response|tools?)>/gi, '< $1$2>');
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function buildPrompt(input: DecideInput, format: PromptFormat): { prompt: string; letters: string[] } {
  if (input.options.length === 0) throw new Error('a decision needs at least one option');
  if (input.options.length > LETTERS.length) throw new Error(`too many options (max ${LETTERS.length})`);
  const letters = input.options.map((_, i) => LETTERS[i]!);
  const lines = input.options.map(
    (o, i) => `${letters[i]}. ${cap(sanitize(o.text).replace(/\s*\n\s*/g, ' ').trim(), MAX_OPTION_CHARS)}`,
  );
  const rawState = sanitize(input.state);
  const state = rawState.length > MAX_STATE_CHARS ? `${rawState.slice(0, MAX_STATE_CHARS)}\n[state truncated]` : rawState;
  const user = `${state}\n\nQuestion: ${cap(sanitize(input.question), MAX_QUESTION_CHARS)}\n${lines.join('\n')}\n\nAnswer with the letter only.`;
  const system = input.system === undefined ? DEFAULT_SYSTEM : cap(sanitize(input.system), MAX_SYSTEM_CHARS);
  const think = format === 'qwen3.5' ? '<think>\n\n</think>\n\n' : '';
  const prompt = `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n${think}`;
  return { prompt, letters };
}

interface TopLogprob {
  token?: unknown;
  logprob?: unknown;
}

export function parseDecision(
  response: unknown,
  letters: string[],
  options: DecideInput['options'],
): Omit<DecideResult, 'latencyMs' | 'promptTokens'> {
  const none = { choice: null, probabilities: {}, gapNats: 0, letterMass: 0 } as const;
  const first = (response as { completion_probabilities?: Array<{ top_logprobs?: TopLogprob[] }> } | null)
    ?.completion_probabilities?.[0];
  const top = first?.top_logprobs;
  if (!Array.isArray(top)) return { ...none };

  const scored = new Map<number, number>(); // option index -> best logprob
  for (const candidate of top) {
    if (typeof candidate.token !== 'string' || typeof candidate.logprob !== 'number') continue;
    const index = letters.indexOf(candidate.token.trim().toUpperCase());
    if (index === -1) continue;
    const previous = scored.get(index);
    if (previous === undefined || candidate.logprob > previous) scored.set(index, candidate.logprob);
  }
  if (scored.size === 0) return { ...none };

  const ranked = [...scored.entries()].sort((a, b) => b[1] - a[1]);
  const letterMass = ranked.reduce((sum, [, lp]) => sum + Math.exp(lp), 0);
  // The model mostly wanted to say something that is not an option: renormalising over the letters
  // would turn a stray low-probability letter into a confident-looking answer.
  if (letterMass < MIN_LETTER_MASS) return { choice: null, probabilities: {}, gapNats: 0, letterMass };

  const best = ranked[0]!;
  const gapNats = ranked.length > 1 ? best[1] - ranked[1]![1] : 20;
  const probabilities: Record<string, number> = {};
  for (const [index, lp] of ranked) probabilities[options[index]!.id] = Math.exp(lp) / letterMass;
  return { choice: options[best[0]]!.id, probabilities, gapNats, letterMass };
}

type SidecarLike = Pick<LlamaSidecar, 'ensureStarted' | 'baseUrl' | 'apiKey' | 'touch'>;

/** One forward pass per decision: the next token over the option letters, read as log-probabilities. */
export class LlamaDecisionEngine implements DecisionEngine {
  constructor(
    private readonly sidecar: SidecarLike,
    private readonly format: PromptFormat,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async decide(input: DecideInput): Promise<DecideResult> {
    const { prompt, letters } = buildPrompt(input, this.format);
    const started = performance.now();
    const json = await this.post(prompt);
    const parsed = parseDecision(json, letters, input.options);
    const tokens = (json as { tokens_evaluated?: unknown }).tokens_evaluated;
    return {
      ...parsed,
      latencyMs: Math.round(performance.now() - started),
      promptTokens: typeof tokens === 'number' ? tokens : 0,
    };
  }

  private async post(prompt: string): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.sidecar.ensureStarted();
      this.sidecar.touch();
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.sidecar.baseUrl()}/completion`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.sidecar.apiKey()}` },
          body: JSON.stringify({ prompt, n_predict: 1, n_probs: 30, temperature: 0, cache_prompt: true }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastError = err; // the sidecar may have crashed: ensureStarted restarts it on the next attempt
        continue;
      }
      if (!res.ok) throw new Error(`decision request failed (HTTP ${res.status})`);
      return res.json();
    }
    throw lastError instanceof Error ? lastError : new Error('decision request failed');
  }
}
