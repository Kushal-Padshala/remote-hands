import type { ActionGate } from '../../action-gate.js';
import type { DecisionEngine } from '../types.js';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program with an argument array: never a shell, so user text can never become a command. */
export interface CommandRunner {
  run(file: string, args: string[], opts?: { timeoutMs?: number }): Promise<CommandResult>;
}

export interface AppCatalog {
  names(): string[];
  /** The one app a spoken name means, several candidates when it is ambiguous, or null. */
  resolve(spoken: string): { name: string } | { candidates: string[] } | null;
}

export interface SkillContext {
  runner: CommandRunner;
  apps: AppCatalog;
  /** Asked before anything irreversible (sending a message). Rejection stops the skill. */
  gate?: ActionGate | undefined;
  /** Used to choose among a few candidates (which of several apps was meant). */
  decide?: DecisionEngine | undefined;
  /** True once the user has stopped the task: a skill must not start an irreversible step after that. */
  cancelled?: (() => boolean) | undefined;
}

export type Slots = Record<string, string>;

export type SkillResult =
  | { ok: true; summary: string }
  /**
   * `declined`: the user said no (or did not answer) to an approval. `uncertain`: the action timed out,
   * so it may already have happened and must not simply be repeated.
   */
  | { ok: false; reason: string; declined?: boolean; uncertain?: boolean };

export interface Skill {
  id: string;
  /** One line for people and logs. */
  description: string;
  /** Strict match of a request: the slots, or null when this skill is not what was asked. */
  extract(query: string, ctx: SkillContext): Promise<Slots | null>;
  run(slots: Slots, ctx: SkillContext): Promise<SkillResult>;
}
