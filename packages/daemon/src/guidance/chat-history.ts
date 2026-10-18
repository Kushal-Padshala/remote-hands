import { plainSummary } from './hud-feed.js';

/** The part of a stored task the chat list needs (a LocalTask has all of it). */
export interface HistoryTask {
  prompt: string;
  status: string;
  conversation_id: string | null;
  result_summary?: string | null;
  created_at: string;
  finished_at?: string | null;
}

export interface ChatTurn {
  goal: string;
  answer: string;
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  turns: ChatTurn[];
}

/** What the HUD lists. `when` is made here so both HUDs say the same words. */
export interface HudHistoryItem {
  id: string;
  title: string;
  when: string;
  count: number;
}

export const HISTORY_MAX_CHATS = 30;
export const HISTORY_MAX_TURNS = 20;
export const HISTORY_TITLE_MAX = 80;
const FALLBACK_GOAL_MAX = 300;
const FINISHED = new Set(['done', 'failed', 'cancelled']);

/** The person's own words: the stored prompt is `Goal: <words>` followed by a block of environment notes. */
export function goalOfPrompt(prompt: string): string {
  const text = prompt.replace(/\r\n?/g, '\n');
  const match = /^Goal: ([\s\S]*?)(?:\n\nActive Environment Context:|$)/.exec(text);
  if (match) return match[1]!.trim();
  return (text.split('\n')[0] ?? '').trim().slice(0, FALLBACK_GOAL_MAX);
}

export function relativeTime(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

function titleOf(goal: string): string {
  const oneLine = goal.replace(/\s+/g, ' ').trim();
  return oneLine.length > HISTORY_TITLE_MAX ? `${oneLine.slice(0, HISTORY_TITLE_MAX - 1).trimEnd()}…` : oneLine;
}

function answerOf(task: HistoryTask): string {
  if (task.status === 'cancelled') return 'Stopped.';
  if (task.status === 'failed') return 'The task failed.';
  return plainSummary(task.result_summary ?? '') || 'Done.';
}

/** Chats the agent can continue (they have a conversation id), newest first, each with its turns oldest first. */
export function buildChatHistory(tasks: HistoryTask[]): ChatSummary[] {
  const finished = tasks
    .filter((t) => t.conversation_id && FINISHED.has(t.status))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const chats = new Map<string, ChatSummary>();
  for (const t of finished) {
    const id = t.conversation_id!;
    const goal = goalOfPrompt(t.prompt);
    const when = Date.parse(t.finished_at ?? '') || Date.parse(t.created_at) || 0;
    let chat = chats.get(id);
    if (!chat) {
      chat = { id, title: titleOf(goal), updatedAt: when, turns: [] };
      chats.set(id, chat);
    }
    chat.turns.push({ goal, answer: answerOf(t) });
    chat.updatedAt = Math.max(chat.updatedAt, when);
  }
  return [...chats.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, HISTORY_MAX_CHATS)
    .map((c) => ({ ...c, turns: c.turns.slice(-HISTORY_MAX_TURNS) }));
}

export function toHistoryItems(chats: ChatSummary[], nowMs: number): HudHistoryItem[] {
  return chats.map((c) => ({ id: c.id, title: c.title, when: relativeTime(c.updatedAt, nowMs), count: c.turns.length }));
}
