/** One option the decision model may choose. `id` is returned to the caller; `text` is what the model reads. */
export interface DecisionOption {
  id: string;
  text: string;
}

export interface DecideInput {
  state: string;
  question: string;
  options: ReadonlyArray<DecisionOption>;
  /** Replaces the default instruction line when a caller needs different wording. */
  system?: string | undefined;
}

export interface DecideResult {
  /** The option id with the highest probability, or null when the model produced no option letter. */
  choice: string | null;
  /** Probability per option id, normalised over the options the model scored. */
  probabilities: Record<string, number>;
  /**
   * Best minus second-best log-probability, in nats. 20 when only one option was scored, 0 when
   * `choice` is null. Small gaps mean the model is unsure; the pilot hands over to the brain.
   */
  gapNats: number;
  /**
   * Probability mass the model put on the option letters (0 to 1). Low mass means it wanted to say
   * something else, so the choice is null rather than a confident-looking guess.
   */
  letterMass: number;
  latencyMs: number;
  promptTokens: number;
}

/** The one interface everything else uses to ask the local model a closed question. */
export interface DecisionEngine {
  decide(input: DecideInput): Promise<DecideResult>;
}
