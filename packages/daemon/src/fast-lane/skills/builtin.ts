import type { CommandResult, Skill, SkillContext, SkillResult, Slots } from './types.js';

/*
 * Built-in instant skills. Two rules hold everywhere:
 *  - a request is matched by a strict, anchored pattern (and closed sets like installed apps), so a
 *    sentence that merely resembles a skill never triggers it;
 *  - nothing user-written is ever placed into a command or script: text reaches osascript only as
 *    argv items after `--`, and everything else in a script is a constant or a validated integer.
 */

const AMBIGUOUS_GAP_NATS = 2;

const firstLine = (text: string, fallback: string): string => text.split('\n').map((l) => l.trim()).find(Boolean) ?? fallback;
const fail = (result: CommandResult, fallback: string): SkillResult => ({ ok: false, reason: firstLine(result.stderr, fallback) });

/** Removes ONE matching pair of straight or curly quotes around the whole text, nothing else. */
function unquote(text: string): string {
  const s = text.trim();
  const pairs: Array<[string, string]> = [['"', '"'], ['“', '”'], ["'", "'"]];
  for (const [open, close] of pairs) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) return s.slice(1, -1).trim();
  }
  return s;
}

/** An osascript invocation whose script is a constant and whose data arrives only as argv. */
function osascriptWithArgs(script: string[], data: string[]): string[] {
  return [...script.flatMap((line) => ['-e', line]), '--', ...data];
}

// ---------------------------------------------------------------------------------------------
// open_app
// ---------------------------------------------------------------------------------------------

const OPEN_APP = /^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:open|launch|start|switch to|bring up)\s+(?:the\s+)?(.+?)(?:\s+(?:app|application))?\s*[.!?]?$/is;

export const openApp: Skill = {
  id: 'open_app',
  description: 'Open or switch to an app that is installed on this Mac.',
  async extract(query, ctx) {
    const m = OPEN_APP.exec(query.trim());
    if (m === null) return null;
    const resolved = ctx.apps.resolve(m[1]!);
    if (resolved === null) return null;
    if ('name' in resolved) return { app: resolved.name };
    if (ctx.decide === undefined) return null;
    const answer = await ctx.decide.decide({
      state: `User request: "${query.trim()}"`,
      question: 'Which app did the user mean?',
      options: resolved.candidates.map((name, i) => ({ id: `a${i}`, text: name })),
    });
    const index = resolved.candidates.findIndex((_, i) => `a${i}` === answer.choice);
    if (index === -1 || answer.gapNats < AMBIGUOUS_GAP_NATS) return null;
    return { app: resolved.candidates[index]! };
  },
  async run(slots, ctx) {
    const app = slots.app ?? '';
    const r = await ctx.runner.run('open', ['-a', app]);
    return r.code === 0 ? { ok: true, summary: `Opened ${app}` } : fail(r, `Could not open ${app}`);
  },
};

// ---------------------------------------------------------------------------------------------
// open_url
// ---------------------------------------------------------------------------------------------

const OPEN_URL = /^(?:please\s+)?(?:open|go to|visit|navigate to|take me to|load)\s+(\S+)\s*[.!?]?$/i;
const BARE_DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]\S*)?$/i;

function toHttpUrl(token: string): URL | null {
  const candidate = /^https?:\/\//i.test(token) ? token : BARE_DOMAIN.test(token) ? `https://${token}` : null;
  if (candidate === null) return null;
  try {
    const url = new URL(candidate);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' ? url : null;
  } catch {
    return null;
  }
}

export const openUrl: Skill = {
  id: 'open_url',
  description: 'Open a web address in the default browser.',
  async extract(query) {
    const m = OPEN_URL.exec(query.trim());
    if (m === null) return null;
    const url = toHttpUrl(m[1]!);
    return url === null ? null : { url: url.href };
  },
  async run(slots, ctx) {
    const url = toHttpUrl(slots.url ?? '');
    if (url === null) return { ok: false, reason: 'Only http and https links can be opened.' };
    const r = await ctx.runner.run('open', [url.href]);
    return r.code === 0 ? { ok: true, summary: `Opened ${url.hostname}` } : fail(r, `Could not open ${url.hostname}`);
  },
};

// ---------------------------------------------------------------------------------------------
// notes_create
// ---------------------------------------------------------------------------------------------

const NOTE_REQUEST = /^(?:please\s+)?(?:create|make|add|write|start|take|new)\s+(?:a\s+|an\s+)?(?:new\s+)?note\b(.*)$/is;
const NOTE_TITLE = /\b(?:called|titled|named)\s+(.+?)(?=\s+(?:saying|that says|containing|with)\b|\s*:|$)/is;
const NOTE_BODY_AFTER_TITLE = /^\s*(?:(?:saying|that says|containing|with(?:\s+the\s+text)?)\s+|:\s*)(.+)$/is;
const NOTE_BODY_PLAIN = /(?:\b(?:saying|that says|containing)\s+|:\s*)(.+)$/is;

function parseNote(rest: string): Slots | null {
  const titleMatch = NOTE_TITLE.exec(rest);
  const tail = titleMatch ? rest.slice(titleMatch.index + titleMatch[0].length) : rest;
  const bodyMatch = (titleMatch ? NOTE_BODY_AFTER_TITLE : NOTE_BODY_PLAIN).exec(tail);
  if (bodyMatch === null) return null;
  const body = unquote(bodyMatch[1]!);
  if (body === '') return null;
  const title = titleMatch ? unquote(titleMatch[1]!) : '';
  return { title: title === '' ? 'Quick note' : title, body };
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const NOTES_SCRIPT = [
  'on run argv',
  'set theTitle to item 1 of argv',
  'set theBody to item 2 of argv',
  'tell application "Notes"',
  'make new note with properties {body:theBody}',
  'end tell',
  'return theTitle',
  'end run',
];

export const notesCreate: Skill = {
  id: 'notes_create',
  description: 'Create a new note in Notes with the text you give.',
  async extract(query) {
    const m = NOTE_REQUEST.exec(query.trim());
    return m === null ? null : parseNote(m[1]!);
  },
  async run(slots, ctx) {
    const title = slots.title ?? 'Quick note';
    const body = `<div><h1>${escapeHtml(title)}</h1></div><div>${escapeHtml(slots.body ?? '').replace(/\r?\n/g, '<br>')}</div>`;
    const r = await ctx.runner.run('osascript', osascriptWithArgs(NOTES_SCRIPT, [title, body]));
    return r.code === 0 ? { ok: true, summary: `Created the note "${title}"` } : fail(r, 'Could not create the note');
  },
};

// ---------------------------------------------------------------------------------------------
// messages_send
// ---------------------------------------------------------------------------------------------

const MSG_VERB = '(?:please\\s+)?(?:send|text|message|imessage)\\s+(?:a\\s+(?:text|message)\\s+)?';
const MSG_QUOTED = /^(?:please\s+)?(?:send|text)\s+(["“])(.+?)["”]\s+to\s+(.+?)\s*[.!]?$/is;
const MSG_SAYING = new RegExp(`^${MSG_VERB}(?:to\\s+)?(.+?)\\s+(?:saying|that says|with the message)\\s+(.+)$`, 'is');
const MSG_COLON = new RegExp(`^${MSG_VERB}(?:to\\s+)?(.+?)\\s*:\\s*(.+)$`, 'is');
const CONTACT = /^[\p{L}\p{N} .'@+\-_]{1,60}$/u;

const MESSAGES_SCRIPT = [
  'on run argv',
  'set theText to item 1 of argv',
  'set theName to item 2 of argv',
  'tell application "Messages"',
  'set targetService to 1st service whose service type = iMessage',
  'set theBuddy to buddy theName of targetService',
  'send theText to theBuddy',
  'end tell',
  'return "sent"',
  'end run',
];

export const messagesSend: Skill = {
  id: 'messages_send',
  description: 'Send an iMessage to a contact, after you approve it.',
  async extract(query) {
    const q = query.trim();
    let contact: string;
    let text: string;
    const quoted = MSG_QUOTED.exec(q);
    if (quoted !== null) {
      text = quoted[2]!;
      contact = quoted[3]!;
    } else {
      const m = MSG_SAYING.exec(q) ?? MSG_COLON.exec(q);
      if (m === null) return null;
      contact = m[1]!;
      text = unquote(m[2]!);
    }
    contact = contact.trim();
    text = text.trim();
    if (!CONTACT.test(contact) || text === '') return null;
    return { contact, text };
  },
  async run(slots, ctx) {
    const contact = slots.contact ?? '';
    const text = slots.text ?? '';
    // Sending is irreversible: never without an approval channel, and a refusal ends the skill.
    if (ctx.gate === undefined) return { ok: false, reason: 'Sending a message needs your approval, but no approval channel is available.' };
    const label = `Send message to ${contact}: ${text.replace(/\s+/g, ' ').slice(0, 60)}`;
    try {
      await ctx.gate(label);
    } catch (err) {
      return { ok: false, declined: true, reason: err instanceof Error ? err.message : String(err) };
    }
    const r = await ctx.runner.run('osascript', osascriptWithArgs(MESSAGES_SCRIPT, [text, contact]));
    return r.code === 0 ? { ok: true, summary: `Sent your message to ${contact}` } : fail(r, `Messages could not send to ${contact}`);
  },
};

// ---------------------------------------------------------------------------------------------
// set_volume
// ---------------------------------------------------------------------------------------------

const VOLUME_SET = /^(?:please\s+)?(?:set\s+)?(?:the\s+)?volume\s+(?:to\s+)?(\d{1,3})\s*%?\s*[.!]?$/i;
const VOLUME_STEP = /^(?:please\s+)?(?:turn\s+)?(?:the\s+)?volume\s+(up|down)\s*[.!]?$/i;
const VOLUME_MUTE = /^(?:please\s+)?(mute|unmute)(?:\s+(?:the\s+)?(?:sound|volume|audio|computer|mac))?\s*[.!]?$/i;

const clamp = (n: number): number => Math.max(0, Math.min(100, n));

export const setVolume: Skill = {
  id: 'set_volume',
  description: 'Set, raise, lower or mute the Mac volume.',
  async extract(query) {
    const q = query.trim();
    const set = VOLUME_SET.exec(q);
    if (set !== null) return { action: 'set', value: set[1]! };
    const step = VOLUME_STEP.exec(q);
    if (step !== null) return { action: step[1]!.toLowerCase() };
    const mute = VOLUME_MUTE.exec(q);
    if (mute !== null) return { action: mute[1]!.toLowerCase() };
    return null;
  },
  async run(slots, ctx) {
    const setTo = async (n: number): Promise<SkillResult> => {
      const r = await ctx.runner.run('osascript', ['-e', `set volume output volume ${n}`]);
      return r.code === 0 ? { ok: true, summary: `Volume ${n}%` } : fail(r, 'Could not change the volume');
    };
    switch (slots.action) {
      case 'set': {
        if (!/^\d{1,3}$/.test(slots.value ?? '')) return { ok: false, reason: 'The volume must be a number from 0 to 100.' };
        return setTo(clamp(Number(slots.value)));
      }
      case 'up':
      case 'down': {
        const read = await ctx.runner.run('osascript', ['-e', 'output volume of (get volume settings)']);
        const current = Number.parseInt(read.stdout.trim(), 10);
        if (read.code !== 0 || Number.isNaN(current)) return { ok: false, reason: 'Could not read the current volume.' };
        return setTo(clamp(current + (slots.action === 'up' ? 10 : -10)));
      }
      case 'mute':
      case 'unmute': {
        const muted = slots.action === 'mute';
        const r = await ctx.runner.run('osascript', ['-e', `set volume output muted ${muted ? 'true' : 'false'}`]);
        return r.code === 0 ? { ok: true, summary: muted ? 'Muted' : 'Unmuted' } : fail(r, 'Could not change the volume');
      }
      default:
        return { ok: false, reason: 'Unknown volume action.' };
    }
  },
};

// ---------------------------------------------------------------------------------------------
// media
// ---------------------------------------------------------------------------------------------

const MEDIA = /^(?:please\s+)?(play|pause|resume|skip|next|previous|go back)(?:\s+(?:this\s+|the\s+)?(music|song|track|playback|spotify|apple music))?\s*[.!]?$/i;
const MEDIA_VERBS: Record<string, string> = { play: 'play', resume: 'play', pause: 'pause', skip: 'next track', next: 'next track', previous: 'previous track', 'go back': 'previous track' };
const ALLOWED_VERBS = new Set(['play', 'pause', 'next track', 'previous track']);
const PLAYERS = ['Spotify', 'Music'] as const;

export const mediaControl: Skill = {
  id: 'media',
  description: 'Play, pause or skip music in Spotify or Music.',
  async extract(query) {
    const m = MEDIA.exec(query.trim());
    if (m === null) return null;
    const slots: Slots = { verb: MEDIA_VERBS[m[1]!.toLowerCase()]! };
    const target = m[2]?.toLowerCase();
    if (target === 'spotify') slots.app = 'Spotify';
    else if (target === 'apple music') slots.app = 'Music';
    return slots;
  },
  async run(slots, ctx) {
    const verb = slots.verb ?? '';
    if (!ALLOWED_VERBS.has(verb)) return { ok: false, reason: 'Unknown music command.' };
    const installed = new Set(ctx.apps.names());
    const wanted = slots.app !== undefined && (PLAYERS as readonly string[]).includes(slots.app) ? slots.app : undefined;

    let app = wanted;
    if (app === undefined) {
      const candidates = PLAYERS.filter((p) => installed.has(p));
      for (const candidate of candidates) {
        const r = await ctx.runner.run('osascript', ['-e', `application "${candidate}" is running`]);
        if (r.stdout.trim() === 'true') {
          app = candidate;
          break;
        }
      }
      if (app === undefined) {
        if (verb !== 'play') return { ok: false, reason: 'No music player is running.' };
        app = candidates[0];
        if (app === undefined) return { ok: false, reason: 'No music player found.' };
      }
    }

    const r = await ctx.runner.run('osascript', ['-e', `tell application "${app}" to ${verb}`]);
    if (r.code !== 0) return fail(r, `Could not control ${app}`);
    const summary =
      verb === 'play' ? `Playing ${app}` : verb === 'pause' ? `Paused ${app}` : verb === 'next track' ? `Skipped to the next track on ${app}` : `Went back a track on ${app}`;
    return { ok: true, summary };
  },
};

export function defaultSkills(): Skill[] {
  return [openApp, openUrl, notesCreate, messagesSend, setVolume, mediaControl];
}

export type { SkillContext };
