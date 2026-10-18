import { describe, it, expect } from 'vitest';
import { buildChatHistory, goalOfPrompt, relativeTime, toHistoryItems, type HistoryTask } from './chat-history.js';

const wrap = (goal: string) => `Goal: ${goal}\n\nActive Environment Context:\n- Frontmost Application: Notes\n\nExecution Mandate:\n1. x`;
const task = (over: Partial<HistoryTask>): HistoryTask => ({
  prompt: wrap('hello'),
  status: 'done',
  conversation_id: 'c1',
  result_summary: 'Hi there',
  created_at: '2026-10-16T10:00:00.000Z',
  finished_at: '2026-10-16T10:01:00.000Z',
  ...over,
});

describe('goalOfPrompt', () => {
  it('takes the words after Goal: up to the context block, multi-line included', () => {
    expect(goalOfPrompt(wrap('add more\nhigh converting'))).toBe('add more\nhigh converting');
  });
  it('falls back to the first line of a prompt in another shape, capped', () => {
    expect(goalOfPrompt('just do the thing\nsecond line')).toBe('just do the thing');
    expect(goalOfPrompt('x'.repeat(500)).length).toBe(300);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  it.each([
    [now - 5_000, 'just now'],
    [now - 5 * 60_000, '5m ago'],
    [now - 3 * 3_600_000, '3h ago'],
    [now - 2 * 86_400_000, '2d ago'],
    [now - 15 * 86_400_000, '2w ago'],
  ])('%s', (then, text) => expect(relativeTime(then, now)).toBe(text));
});

describe('buildChatHistory', () => {
  it('groups turns by conversation, oldest turn first, newest chat first', () => {
    const chats = buildChatHistory([
      task({ conversation_id: 'a', prompt: wrap('first'), result_summary: 'one', created_at: '2026-10-16T10:00:00.000Z', finished_at: '2026-10-16T10:01:00.000Z' }),
      task({ conversation_id: 'b', prompt: wrap('other chat'), result_summary: 'x', created_at: '2026-10-17T10:00:00.000Z', finished_at: '2026-10-17T10:01:00.000Z' }),
      task({ conversation_id: 'a', prompt: wrap('second'), result_summary: 'two', created_at: '2026-10-16T10:05:00.000Z', finished_at: '2026-10-16T10:06:00.000Z' }),
    ]);
    expect(chats.map((c) => c.id)).toEqual(['b', 'a']);
    expect(chats[1]!.title).toBe('first');
    expect(chats[1]!.turns).toEqual([{ goal: 'first', answer: 'one' }, { goal: 'second', answer: 'two' }]);
    expect(chats[1]!.updatedAt).toBe(Date.parse('2026-10-16T10:06:00.000Z'));
  });
  it('skips tasks with no conversation id and tasks still running', () => {
    expect(buildChatHistory([task({ conversation_id: null }), task({ status: 'running' }), task({ status: 'queued' })])).toEqual([]);
  });
  it('keeps a failed or stopped turn with a plain answer', () => {
    const [chat] = buildChatHistory([
      task({ status: 'failed', result_summary: null }),
      task({ status: 'cancelled', result_summary: null, created_at: '2026-10-16T11:00:00.000Z', finished_at: null }),
    ]);
    expect(chat!.turns.map((t) => t.answer)).toEqual(['The task failed.', 'Stopped.']);
  });
  it('turns the agent markdown into plain text like the HUD shows it', () => {
    const [chat] = buildChatHistory([task({ result_summary: '**Done** with `x`' })]);
    expect(chat!.turns[0]!.answer).toBe('Done with x');
  });
  it('caps titles at 80 characters on one line and keeps 30 chats of 20 turns', () => {
    const [long] = buildChatHistory([task({ prompt: wrap(`${'word '.repeat(40)}\nmore`) })]);
    expect(long!.title.length).toBeLessThanOrEqual(80);
    expect(long!.title).not.toContain('\n');
    const many = Array.from({ length: 35 }, (_, i) =>
      task({ conversation_id: `c${i}`, created_at: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T10:00:00.000Z`, finished_at: null }),
    );
    expect(buildChatHistory(many).length).toBe(30);
    const turns = Array.from({ length: 25 }, (_, i) =>
      task({ prompt: wrap(`t${i}`), created_at: `2026-10-01T10:${String(i).padStart(2, '0')}:00.000Z`, finished_at: null }),
    );
    const [deep] = buildChatHistory(turns);
    expect(deep!.turns.length).toBe(20);
    expect(deep!.turns.at(-1)!.goal).toBe('t24');
  });
});

describe('toHistoryItems', () => {
  it('gives the HUD id, title, short time and message count', () => {
    const now = Date.parse('2026-10-16T12:00:00Z');
    const items = toHistoryItems(buildChatHistory([task({})]), now);
    expect(items).toEqual([{ id: 'c1', title: 'hello', when: '1h ago', count: 1 }]);
  });
});
