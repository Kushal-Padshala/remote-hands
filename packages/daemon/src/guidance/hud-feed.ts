import type { HudUpdateSender } from '../desktop/spotlight-hud.js';

/**
 * What the HUD shows while the agent works: a short pill word ("READING", "CLICKING") and, for
 * things that actually happened, one plain sentence ("Clicked \"Next\""). The agent's own
 * streaming text, its reasoning and its tool plumbing never reach the screen; the full event log
 * is still stored untouched by the caller.
 *
 * Rules that keep it honest:
 *  - only a result that really succeeded is announced, and a batch is described by what the tool
 *    says it did, never by what was planned;
 *  - what was typed, and the names of fields (which can be built from their contents), are never shown;
 *  - a failure, a declined action or an unconfirmed one is said plainly;
 *  - when the agent asks the person to do something ("please sign in"), that one sentence is shown.
 */

const MAX_LABEL = 40;
const MAX_ERROR = 140;
const MAX_NEEDS = 140;
const MAX_HOST = 60;
const MAX_PENDING = 64;
const MAX_NARRATION = 4000;

const shorten = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

const quoted = (label: string): string => `"${shorten(label, MAX_LABEL).replace(/"/g, "'")}"`;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The site name only: no scheme, path, query, credentials or port; never an unparsed string. */
function hostOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw || raw.length > 2048) return null;
  // "example.com/x" has no scheme and is opened as https; anything with its own scheme is judged as written.
  const explicit = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(javascript|data|file|about|blob|mailto|tel|chrome|view-source):/i.test(raw);
  try {
    const u = new URL(explicit ? raw : `https://${raw}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.replace(/^www\./i, '');
    return host && host.length <= MAX_HOST ? host : null;
  } catch {
    return null;
  }
}

// ---- plain text from Markdown ---------------------------------------------------------------

const INLINE_CODE = /(`[^`\n]*`)/;

/** A Markdown table's `| --- | :-: |` row: layout only, nothing to read. */
const isTableSeparator = (line: string): boolean => line.includes('|') && /^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|?[ \t]*$/.test(line);

/** Markdown outside code, as plain text. Every pattern is line-local and bounded, so it cannot backtrack badly. */
function plainLine(line: string): string {
  let s = line;
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]*/, '');
  s = s.replace(/^([ \t]*)[-*+][ \t]+/, (_m, indent: string) => `${indent}• `);
  if (/^[ \t]*\|.*\|[ \t]*$/.test(s)) s = s.trim().slice(1, -1).split('|').map((c) => c.trim()).join(' · ');
  s = s.replace(/\[([^\]\n]{0,200})\]\(((?:[^()\s]|\([^()\s]*\)){0,500})\)/g, (_m, label: string, url: string) => label.trim() || url);
  s = s.replace(/(\*\*|__)([^\n]{1,300}?)\1/g, '$2');
  s = s.replace(/~~([^\n]{1,300}?)~~/g, '$1');
  s = s.replace(/(?<![\w*])\*(?![\s*])([^*\n]{1,300}?)(?<![\s*])\*(?![\w*])/g, '$1');
  return s;
}

/** Markdown the agent writes, as plain text for the HUD: no #, **, backticks or link syntax; code is left as written. */
export function plainSummary(text: string, max = 4000): string {
  // Anything past the cap is dropped before any pattern runs.
  const lines = text.slice(0, max * 2).replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^[ \t]*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (isTableSeparator(line)) continue;
    out.push(
      line
        .split(INLINE_CODE)
        .map((part) => (part.length > 1 && part.startsWith('`') && part.endsWith('`') ? part.slice(1, -1) : plainLine(part)))
        .join(''),
    );
  }
  const s = out.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

// ---- what a tool call means to a person -----------------------------------------------------

interface Result {
  ok: boolean;
  output: string;
}

interface Planned {
  /** Pill word while the call runs. */
  pill: string;
  /** A sentence shown the moment the call starts, for a step that takes noticeably longer than the rest and would otherwise look stuck. */
  before?: string;
  /** The sentence to show once it finished, or null to say nothing. Only called for a successful result. */
  after: (result: Result) => string | null;
  /** A plainer sentence for a failure the person can do something about; null: the usual one. */
  failure?: (result: Result) => string | null;
  /** A plain "That didn't work." is the agent's own business for reads, commands and unknown tools. */
  quietFailure?: true;
}

const none = (): null => null;
const reading = (): Planned => ({ pill: 'READING', after: none, quietFailure: true });

const firstLine = (output: string): string => (output.split('\n')[0] ?? '').trim();

/** MCP tools can return their answer as `{ isError, content: [{ text }] }`; flatten that to what a person would read. */
export function flattenResult(rawOk: boolean, raw: unknown): Result {
  let text = typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : JSON.stringify(raw);
  let ok = rawOk;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.length < 200_000) {
    try {
      const parsed = JSON.parse(trimmed) as { isError?: unknown; content?: unknown };
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.content)) {
        text = parsed.content
          .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
          .filter(Boolean)
          .join('\n');
        if (parsed.isError === true) ok = false;
      }
    } catch {
      // not an envelope: keep the text as it is
    }
  }
  return { ok, output: text };
}

const FAILED = "That didn't work.";

/** The sentence for a result that did not simply succeed, or null when it succeeded. */
function failureLine(r: Result): string | null {
  const head = firstLine(r.output);
  const errored = !r.ok || /^\s*error:/i.test(r.output) || /^step \d+ .* failed:/i.test(head);
  if (!errored) return null;
  if (/approval rejected|was not pressed|declined/i.test(r.output)) return "That action wasn't approved, so it was skipped.";
  if (/\bran, but checking the page afterwards failed/i.test(r.output)) return "That step ran, but I couldn't confirm it worked.";
  if (/abandoned|ran out of time|timed out/i.test(r.output)) return 'That took too long and was stopped.';
  return FAILED;
}

/** The steps the tool says it ran: the `did: type, click` line, not the plan. */
function executedOps(output: string): string[] | null {
  const m = /^did: (.+)$/m.exec(output);
  return m ? m[1]!.split(',').map((s) => s.trim()).filter(Boolean) : null;
}

function planBrowserDo(args: Record<string, unknown>): Planned {
  const steps = Array.isArray(args.steps) ? (args.steps as Array<Record<string, unknown>>) : [];
  const planned = steps.map((s) => String(s?.op ?? ''));
  const pill = planned.some((o) => o === 'type' || o === 'select' || o === 'check')
    ? 'FILLING'
    : planned.includes('click')
      ? 'CLICKING'
      : planned.every((o) => o === 'wait' || o === 'scroll' || o === '')
        ? 'WAITING'
        : 'WORKING';
  return {
    pill,
    after: (r) => {
      const ran = executedOps(r.output);
      if (!ran) return null;
      const count = (op: string): number => ran.filter((o) => o === op).length;
      const fields = count('type') + count('select') + count('check');
      const clicks = count('click');
      const parts: string[] = [];
      if (fields > 0) parts.push(`filled in ${plural(fields, 'field')}`);
      if (clicks > 0) parts.push(`clicked ${plural(clicks, 'button')}`);
      if (parts.length === 0 && count('press') > 0) parts.push('pressed a key');
      if (parts.length === 0) return null;
      // A single click on a labelled button reads better by name (a button's text is shown on screen anyway).
      const only = steps.length === 1 ? steps[0]! : null;
      if (only && clicks === 1 && fields === 0 && typeof only.target === 'string' && only.target.trim()) return `Clicked ${quoted(only.target)}`;
      const sentence = parts.join(' and ');
      return sentence.charAt(0).toUpperCase() + sentence.slice(1);
    },
  };
}

/** Reading a window by sight is the one slow way of looking; say so while it runs, so a pause there does not look like a hang. */
const BY_SIGHT_BEFORE = "Reading this window by sight, because the app doesn't show its buttons. This takes a moment.";

const bySight = (): Planned => ({
  pill: 'READING THE SCREEN',
  before: BY_SIGHT_BEFORE,
  after: () => 'Read the window by sight',
  failure: (r) => (/screen recording/i.test(r.output) ? 'Remote Hands needs Screen Recording permission to read this window. Switch it on in System Settings.' : null),
  quietFailure: true,
});

function planMcp(name: string, args: Record<string, unknown>): Planned {
  switch (name) {
    case 'desktop_snapshot':
      return args.ocr === true ? bySight() : reading();
    case 'browser_snapshot':
    case 'browser_find':
    case 'browser_extract':
    case 'browser_tabs':
    case 'desktop_windows':
      return reading();
    case 'browser_open': {
      const host = hostOf(args.url);
      return { pill: 'OPENING', after: () => (host ? `Opened ${host}` : 'Opened a page') };
    }
    case 'browser_focus':
      return { pill: 'OPENING', after: () => 'Switched tab' };
    case 'browser_click':
      return {
        pill: 'CLICKING',
        after: (r) => {
          const m = /^clicked \[[^\]]*\]\s*(.+)$/i.exec(firstLine(r.output));
          return m ? `Clicked ${quoted(m[1]!)}` : 'Clicked a button';
        },
      };
    case 'browser_type':
      // Neither the text nor the field's name is shown: names can be built from a field's contents.
      return { pill: 'TYPING', after: () => 'Typed into a field' };
    case 'browser_do':
      return planBrowserDo(args);
    case 'desktop_click':
      return {
        pill: 'CLICKING',
        after: (r) => {
          const m = /^clicked \[[^\]]*\]\s*\S+\s+"(.*)"/i.exec(firstLine(r.output));
          return m ? `Clicked ${quoted(m[1]!)}` : 'Clicked an item';
        },
      };
    case 'desktop_type':
      return { pill: 'TYPING', after: () => 'Typed some text' };
    case 'desktop_key': {
      const combo = typeof args.combo === 'string' ? shorten(args.combo, 24) : '';
      return { pill: 'TYPING', after: () => (combo ? `Pressed ${combo}` : 'Pressed a key') };
    }
    case 'desktop_open': {
      const app = typeof args.app === 'string' ? shorten(args.app, 30) : '';
      return { pill: 'OPENING', after: () => (app ? `Opened ${app}` : 'Opened an app') };
    }
    case 'desktop_menu': {
      const app = typeof args.app === 'string' ? shorten(args.app, 30) : '';
      return { pill: 'CLICKING', after: () => (app ? `Used the ${app} menu` : 'Used a menu') };
    }
    case 'computer_batch': {
      const steps = Array.isArray(args.steps) ? (args.steps as Array<Record<string, unknown>>) : [];
      const sight = steps.some((s) => s?.tool === 'desktop_snapshot' && s.args && typeof s.args === 'object' && (s.args as Record<string, unknown>).ocr === true);
      return { pill: 'WORKING', ...(sight ? { before: BY_SIGHT_BEFORE } : {}), after: () => 'Ran several steps' };
    }
    default:
      return { pill: 'WORKING', after: none, quietFailure: true };
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
      return { pill: 'RUNNING', after: () => 'Ran a command on your computer', quietFailure: true };
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
      return { pill: 'EDITING', after: () => (file ? `Edited ${file}` : 'Edited a file'), quietFailure: true };
    }
    default:
      return { pill: 'WORKING', after: none, quietFailure: true };
  }
}

// ---- the agent asking the person to do something ---------------------------------------------

const NEEDS_YOU =
  /\b(please\s+(sign|log)\s?in|please\s+(approve|confirm|complete|enter|check|unlock|allow|solve)|(need|needs|require|requires)\s+you\s+to|waiting\s+(for|on)\s+you|captcha|verification\s+code|two-factor|2fa|one-time\s+(code|password)|your\s+(password|passcode|approval|confirmation)|(can'?t|cannot|unable\s+to|couldn'?t)\s+(continue|proceed|log\s?in|sign\s?in|access))\b/i;

/** The one sentence in what the agent said so far that asks the person for something, if any. */
function needsYouSentence(text: string): string | null {
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const clean = plainSummary(sentence, 400);
    if (clean && NEEDS_YOU.test(clean)) return shorten(clean, MAX_NEEDS);
  }
  return null;
}

/**
 * Turns the agent's event stream into HUD updates. Stateful: it remembers what each running
 * tool call was, so the sentence can say what happened once the result arrives, and it never
 * repeats a line or a pill word twice in a row. Create one per task.
 */
export class HudFeed {
  private readonly pending = new Map<string, Planned>();
  private lastPill = '';
  private lastLine = '';
  private narration = '';

  constructor(private readonly send: HudUpdateSender) {}

  event(ev: unknown): void {
    if (!ev || typeof ev !== 'object') return;
    const e = ev as Record<string, any>;
    const kind = e.kind ?? e.type;
    const payload = e.payload && typeof e.payload === 'object' ? e.payload : e;

    switch (kind) {
      case 'tool_call': {
        this.flushNarration();
        const planned = planTool(payload.tool, payload.input);
        const id = String(payload.call_id ?? '');
        if (id) {
          this.pending.set(id, planned);
          if (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value as string);
        }
        if (planned.before && planned.before !== this.lastLine) {
          this.lastLine = planned.before;
          this.lastPill = planned.pill;
          this.send(planned.pill, planned.before, 'ACTION');
        } else {
          this.pill(planned.pill);
        }
        return;
      }
      case 'tool_result': {
        const id = String(payload.call_id ?? '');
        const planned = this.pending.get(id);
        this.pending.delete(id);
        if (planned) {
          const result = flattenResult(payload.ok !== false, payload.output);
          const failed = failureLine(result);
          const line = failed !== null ? (planned.failure?.(result) ?? failed) : planned.after(result);
          if (line && !(line === FAILED && planned.quietFailure)) this.line(line, failed !== null ? 'PROBLEM' : 'ACTION');
        }
        this.pill('THINKING');
        return;
      }
      case 'thinking':
        this.flushNarration();
        this.pill('THINKING');
        return;
      case 'agent_text': {
        // The answer streams in as small fragments and is shown once, whole, on completion. Only a
        // request for the person to act is picked out.
        if (typeof payload.text === 'string') this.narration = (this.narration + payload.text).slice(-MAX_NARRATION);
        this.pill('WRITING');
        return;
      }
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

  private flushNarration(): void {
    const said = this.narration;
    this.narration = '';
    const ask = said ? needsYouSentence(said) : null;
    if (ask && ask !== this.lastLine) {
      this.lastLine = ask;
      this.lastPill = 'WORKING';
      this.send('WORKING', ask, 'ATTENTION');
    }
  }

  private pill(word: string): void {
    if (word === this.lastPill) return;
    this.lastPill = word;
    this.send(word, '');
  }

  /** `role` is ACTION for something that happened and PROBLEM for something that did not work out. */
  private line(text: string, role: 'ACTION' | 'PROBLEM'): void {
    if (text === this.lastLine) return;
    this.lastLine = text;
    this.lastPill = 'WORKING';
    this.send('WORKING', text, role);
  }
}
