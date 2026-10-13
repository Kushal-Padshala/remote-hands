import type { HudUpdateSender } from '../desktop/spotlight-hud.js';

/**
 * What the HUD shows while the agent works: a short pill word ("READING", "CLICKING") and, for
 * things that actually happened, one plain sentence ("Clicked \"Next\""). The agent's own
 * streaming text, its reasoning and its tool plumbing never reach the screen; the full event log
 * is still stored untouched by the caller.
 */

const MAX_LABEL = 40;
const MAX_ERROR = 140;
const MAX_PENDING = 64;

const shorten = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

const quoted = (label: string): string => `"${shorten(label, MAX_LABEL).replace(/"/g, "'")}"`;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function hostOf(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol === 'about:' || !u.host) return null;
    return u.host.replace(/^www\./i, '');
  } catch {
    return shorten(url, 50);
  }
}

/** Markdown the agent writes, as plain text for the HUD: no #, **, backticks or link syntax. */
export function plainSummary(text: string, max = 4000): string {
  let s = text.replace(/\r\n?/g, '\n');
  s = s.replace(/^```[^\n]*\n?/gm, '').replace(/```/g, '');
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '');
  s = s.replace(/^(\s*)[-*+]\s+/gm, (_m, indent: string) => `${indent}• `);
  s = s.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (_m, label: string, url: string) => label.trim() || url);
  s = s.replace(/(\*\*|__)(.+?)\1/gs, '$2');
  s = s.replace(/`([^`\n]*)`/g, '$1');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

interface Planned {
  /** Pill word while the call runs. */
  pill: string;
  /** The sentence to show once it finished, or null to say nothing. */
  after: (result: { ok: boolean; output: string }) => string | null;
}

const none = (): null => null;
const FAILED = "That didn't work. Trying another way.";

const reading = (): Planned => ({ pill: 'READING', after: none });

/** A browser/desktop tool result that reports failure in its text. */
const failed = (r: { ok: boolean; output: string }): boolean => !r.ok || /^\s*error:/i.test(r.output);

function firstLine(output: string): string {
  return (output.split('\n')[0] ?? '').trim();
}

function planBrowserDo(args: Record<string, unknown>): Planned {
  const steps = Array.isArray(args.steps) ? (args.steps as Array<Record<string, unknown>>) : [];
  const ops = steps.map((s) => String(s?.op ?? ''));
  const fields = ops.filter((o) => o === 'type' || o === 'select' || o === 'check').length;
  const clicks = ops.filter((o) => o === 'click').length;
  const presses = ops.filter((o) => o === 'press').length;
  const only = steps.length === 1 ? steps[0]! : null;
  const pill = fields > 0 ? 'FILLING' : clicks > 0 ? 'CLICKING' : ops.every((o) => o === 'wait' || o === 'scroll' || o === '') ? 'WAITING' : 'WORKING';
  return {
    pill,
    after: (r) => {
      if (failed(r)) return FAILED;
      if (only && clicks === 1 && typeof only.target === 'string' && only.target.trim()) return `Clicked ${quoted(only.target)}`;
      if (only && fields === 1 && typeof only.target === 'string' && only.target.trim()) return `Filled in ${quoted(only.target)}`;
      const parts: string[] = [];
      if (fields > 0) parts.push(`filled in ${plural(fields, 'field')}`);
      if (clicks > 0) parts.push(`clicked ${plural(clicks, 'button')}`);
      if (presses > 0 && parts.length === 0) parts.push('pressed a key');
      if (parts.length === 0) return null;
      const sentence = parts.join(' and ');
      return sentence.charAt(0).toUpperCase() + sentence.slice(1);
    },
  };
}

function planMcp(name: string, args: Record<string, unknown>): Planned {
  switch (name) {
    case 'browser_snapshot':
    case 'browser_find':
    case 'browser_extract':
    case 'browser_tabs':
    case 'desktop_snapshot':
    case 'desktop_windows':
      return reading();
    case 'browser_open': {
      const host = hostOf(args.url);
      return { pill: 'OPENING', after: (r) => (failed(r) ? FAILED : host ? `Opened ${host}` : 'Opened a page') };
    }
    case 'browser_focus':
      return { pill: 'OPENING', after: (r) => (failed(r) ? FAILED : 'Switched tab') };
    case 'browser_click':
      return {
        pill: 'CLICKING',
        after: (r) => {
          if (failed(r)) return FAILED;
          const m = /^clicked \[[^\]]*\]\s*(.+)$/i.exec(firstLine(r.output));
          return m ? `Clicked ${quoted(m[1]!)}` : 'Clicked a button';
        },
      };
    case 'browser_type':
      return {
        pill: 'TYPING',
        after: (r) => {
          if (failed(r)) return FAILED;
          // Only the field's name: what was typed (it may be a password) is never shown.
          const m = /^typed into \[[^\]]*\]\s*(.+)$/i.exec(firstLine(r.output));
          return m ? `Typed into ${quoted(m[1]!)}` : 'Typed some text';
        },
      };
    case 'browser_do':
      return planBrowserDo(args);
    case 'desktop_click':
      return {
        pill: 'CLICKING',
        after: (r) => {
          if (failed(r)) return FAILED;
          const m = /^clicked \[[^\]]*\]\s*\S+\s+"(.*)"/i.exec(firstLine(r.output));
          return m ? `Clicked ${quoted(m[1]!)}` : 'Clicked an item';
        },
      };
    case 'desktop_type':
      return { pill: 'TYPING', after: (r) => (failed(r) ? FAILED : 'Typed some text') };
    case 'desktop_key': {
      const combo = typeof args.combo === 'string' ? shorten(args.combo, 24) : '';
      return { pill: 'TYPING', after: (r) => (failed(r) ? FAILED : combo ? `Pressed ${combo}` : 'Pressed a key') };
    }
    case 'desktop_open': {
      const app = typeof args.app === 'string' ? shorten(args.app, 30) : '';
      return { pill: 'OPENING', after: (r) => (failed(r) ? FAILED : app ? `Opened ${app}` : 'Opened an app') };
    }
    case 'desktop_menu': {
      const app = typeof args.app === 'string' ? shorten(args.app, 30) : '';
      return { pill: 'CLICKING', after: (r) => (failed(r) ? FAILED : app ? `Used the ${app} menu` : 'Used a menu') };
    }
    case 'computer_batch':
      return { pill: 'WORKING', after: (r) => (failed(r) ? FAILED : 'Ran several steps') };
    default:
      return { pill: 'WORKING', after: none };
  }
}

function fileName(input: Record<string, unknown>): string | null {
  const raw = input.TargetFile ?? input.AbsolutePath ?? input.path ?? input.file_path;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return shorten(raw.split(/[\\/]/).filter(Boolean).pop() ?? '', MAX_LABEL) || null;
}

/** What a tool call means to a person, for any tool the agent has. Unknown tools say nothing. */
export function planTool(tool: unknown, input: unknown): Planned {
  const name = typeof tool === 'string' ? tool : '';
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (name === 'call_mcp_tool') {
    const inner = typeof args.ToolName === 'string' ? args.ToolName : '';
    const innerArgs = args.Arguments && typeof args.Arguments === 'object' ? (args.Arguments as Record<string, unknown>) : {};
    return planMcp(inner, innerArgs);
  }
  if (name.startsWith('browser_') || name.startsWith('desktop_') || name === 'computer_batch') return planMcp(name, args);
  switch (name) {
    case 'run_command':
      return { pill: 'RUNNING', after: (r) => (r.ok ? 'Ran a command on your computer' : null) };
    case 'view_file':
    case 'list_dir':
    case 'grep_search':
    case 'find_by_name':
    case 'read_url_content':
      return reading();
    case 'write_to_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'edit_file': {
      const file = fileName(args);
      return { pill: 'EDITING', after: (r) => (r.ok ? (file ? `Edited ${file}` : 'Edited a file') : null) };
    }
    default:
      return { pill: 'WORKING', after: none };
  }
}

/**
 * Turns the agent's event stream into HUD updates. Stateful: it remembers what each running
 * tool call was, so the sentence can say what happened once the result arrives, and it never
 * repeats a line or a pill word twice in a row.
 */
export class HudFeed {
  private readonly pending = new Map<string, Planned>();
  private lastPill = '';
  private lastLine = '';

  constructor(private readonly send: HudUpdateSender) {}

  event(ev: unknown): void {
    if (!ev || typeof ev !== 'object') return;
    const e = ev as Record<string, any>;
    const kind = e.kind ?? e.type;
    const payload = e.payload && typeof e.payload === 'object' ? e.payload : e;

    switch (kind) {
      case 'tool_call': {
        const planned = planTool(payload.tool, payload.input);
        const id = String(payload.call_id ?? '');
        if (id) {
          this.pending.set(id, planned);
          if (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value as string);
        }
        this.pill(planned.pill);
        return;
      }
      case 'tool_result': {
        const id = String(payload.call_id ?? '');
        const planned = this.pending.get(id);
        this.pending.delete(id);
        if (planned) {
          const line = planned.after({ ok: payload.ok !== false, output: typeof payload.output === 'string' ? payload.output : '' });
          if (line) this.line(line);
        }
        this.pill('THINKING');
        return;
      }
      case 'thinking':
        this.pill('THINKING');
        return;
      case 'agent_text':
        // The answer streams in as small fragments; the finished answer is shown once, on completion.
        this.pill('WRITING');
        return;
      case 'error': {
        const message = typeof payload.message === 'string' ? shorten(payload.message, MAX_ERROR) : '';
        if (message && message !== this.lastLine) {
          this.lastLine = message;
          this.send('ERROR', message, 'ERROR');
        }
        return;
      }
      default:
        return; // status and result events carry nothing a person needs to read
    }
  }

  private pill(word: string): void {
    if (word === this.lastPill) return;
    this.lastPill = word;
    this.send(word, '');
  }

  private line(text: string): void {
    if (text === this.lastLine) return;
    this.lastLine = text;
    this.lastPill = 'WORKING';
    this.send('WORKING', text, 'ACTION');
  }
}
