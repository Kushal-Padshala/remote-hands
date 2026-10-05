import { describe, expect, it, vi } from 'vitest';
import type { DecisionEngine } from '../types.js';
import { mediaControl, messagesSend, notesCreate, openApp, openUrl, setVolume, defaultSkills } from './builtin.js';
import type { AppCatalog, CommandResult, CommandRunner, SkillContext } from './types.js';

type Call = [string, string[]];

function fakeRunner(results: Array<Partial<CommandResult>> = []) {
  const calls: Call[] = [];
  const runner: CommandRunner = {
    run: vi.fn(async (file: string, args: string[]) => {
      calls.push([file, args]);
      return { code: 0, stdout: '', stderr: '', ...(results.shift() ?? {}) };
    }),
  };
  return { runner, calls };
}

const catalog = (names: string[]): AppCatalog => ({
  names: () => names,
  resolve: (spoken) => {
    const w = spoken.toLowerCase().replace(/^the /, '').trim();
    if (!w) return null;
    const exact = names.find((n) => n.toLowerCase() === w);
    if (exact) return { name: exact };
    const m = names.filter((n) => n.toLowerCase().includes(w));
    return m.length === 0 ? null : m.length === 1 ? { name: m[0]! } : { candidates: m };
  },
});

const mk = (over: Partial<SkillContext> & { results?: Array<Partial<CommandResult>>; names?: string[] } = {}) => {
  const { runner, calls } = fakeRunner(over.results);
  const ctx: SkillContext = { runner, apps: catalog(over.names ?? ['Notes', 'Spotify', 'Google Chrome', 'Google Earth', 'Safari', 'Arc', 'Messages', 'Music']), ...(over.gate ? { gate: over.gate } : {}), ...(over.decide ? { decide: over.decide } : {}) };
  return { ctx, calls };
};

const HOSTILE = ['"; do shell script "rm -rf ~"; "', '`id` $(whoami)', 'a\nb\\c "q" \'s\'', '-v --help'];

describe('open_app', () => {
  it.each([
    ['open spotify', 'Spotify'],
    ['Open Notes', 'Notes'],
    ['launch the notes app', 'Notes'],
    ['please open Safari', 'Safari'],
    ['can you open arc', 'Arc'],
    ['switch to Spotify.', 'Spotify'],
    ['bring up the Notes application', 'Notes'],
  ])('matches %j', async (q, app) => {
    const { ctx } = mk();
    expect(await openApp.extract(q, ctx)).toEqual({ app });
  });

  it.each([
    'open the pod bay doors',
    'open Arc and see the meta ads status',
    'start the day with some music',
    'open',
    'please launch',
    'opening statements',
    'how do I open a file',
  ])('does not match %j', async (q) => {
    const { ctx } = mk();
    expect(await openApp.extract(q, ctx)).toBeNull();
  });

  it('opens the app with an argument array', async () => {
    const { ctx, calls } = mk();
    const r = await openApp.run({ app: 'Spotify' }, ctx);
    expect(r).toEqual({ ok: true, summary: 'Opened Spotify' });
    expect(calls).toEqual([['open', ['-a', 'Spotify']]]);
  });

  it('reports a failed open with the first line of the error', async () => {
    const { ctx } = mk({ results: [{ code: 1, stderr: 'Unable to find application\nmore' }] });
    expect(await openApp.run({ app: 'Ghost' }, ctx)).toEqual({ ok: false, reason: 'Unable to find application' });
  });

  it('asks the decider when several apps match and accepts a clear answer', async () => {
    const decide: DecisionEngine = { decide: vi.fn(async (i) => ({ choice: i.options[1]!.id, probabilities: {}, gapNats: 6, letterMass: 1, latencyMs: 1, promptTokens: 1 })) };
    const { ctx } = mk({ decide });
    expect(await openApp.extract('open google', ctx)).toEqual({ app: 'Google Earth' });
    const asked = (decide.decide as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(asked.options.map((o: { text: string }) => o.text)).toEqual(['Google Chrome', 'Google Earth']);
  });

  it('declines an ambiguous app without a decider or with an unsure one', async () => {
    expect(await openApp.extract('open google', mk().ctx)).toBeNull();
    const unsure: DecisionEngine = { decide: async (i) => ({ choice: i.options[0]!.id, probabilities: {}, gapNats: 0.5, letterMass: 1, latencyMs: 1, promptTokens: 1 }) };
    expect(await openApp.extract('open google', mk({ decide: unsure }).ctx)).toBeNull();
  });
});

describe('open_url', () => {
  it.each([
    ['open https://example.com/a?b=1', 'https://example.com/a?b=1'],
    ['go to example.org', 'https://example.org/'],
    ['visit github.com/anthropics', 'https://github.com/anthropics'],
    ['please open http://localhost.test:8080/x', 'http://localhost.test:8080/x'],
  ])('matches %j', async (q, url) => {
    expect(await openUrl.extract(q, mk().ctx)).toEqual({ url });
  });

  it.each([
    'tell me about example.com',
    'open file:///etc/passwd',
    'open javascript:alert(1)',
    'open ftp://example.com',
    'open the settings',
    'what does https://example.com say',
  ])('does not match %j', async (q) => {
    expect(await openUrl.extract(q, mk().ctx)).toBeNull();
  });

  it('opens the URL with an argument array', async () => {
    const { ctx, calls } = mk();
    expect(await openUrl.run({ url: 'https://example.com/' }, ctx)).toEqual({ ok: true, summary: 'Opened example.com' });
    expect(calls).toEqual([['open', ['https://example.com/']]]);
  });

  it('refuses a non-http URL even if called directly', async () => {
    const { ctx, calls } = mk();
    const r = await openUrl.run({ url: 'file:///etc/passwd' }, ctx);
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('notes_create', () => {
  it.each([
    ['make a note called groceries with milk, eggs and bread', 'groceries', 'milk, eggs and bread'],
    ['create a new note: buy a charger', 'Quick note', 'buy a charger'],
    ['add a note titled "ideas" saying build a decision router', 'ideas', 'build a decision router'],
    ['write a note that says call the dentist at 9', 'Quick note', 'call the dentist at 9'],
    ['new note called "Trip": pack passport and charger', 'Trip', 'pack passport and charger'],
    ['make a note saying "line one\nline two"', 'Quick note', 'line one\nline two'],
  ])('matches %j', async (q, title, body) => {
    expect(await notesCreate.extract(q, mk().ctx)).toEqual({ title, body });
  });

  it.each(['make a note', 'what is a note', 'I need to take notes in class', 'open notes', 'notes app please'])('does not match %j', async (q) => {
    expect(await notesCreate.extract(q, mk().ctx)).toBeNull();
  });

  it('copies the body verbatim from the request', async () => {
    const q = 'make a note called x saying Pick up Åsa @ 5:30 — don\'t forget "the cake"';
    const slots = await notesCreate.extract(q, mk().ctx);
    expect(q).toContain(slots!.body);
    expect(slots!.body).toContain('Åsa @ 5:30');
  });

  it.each(HOSTILE)('passes hostile text %j only as argv, never in the script source', async (text) => {
    const { ctx, calls } = mk();
    await notesCreate.run({ title: text, body: text }, ctx);
    const [file, args] = calls[0]!;
    expect(file).toBe('osascript');
    const scriptArgs = args.slice(0, args.indexOf('--'));
    expect(scriptArgs.every((a, i) => (i % 2 === 0 ? a === '-e' : !a.includes(text)))).toBe(true);
    const userArgs = args.slice(args.indexOf('--') + 1);
    expect(userArgs).toHaveLength(2);
    expect(userArgs[0]).toBe(text);
  });

  it('builds an HTML body with the title as a heading and escaped text', async () => {
    const { ctx, calls } = mk();
    await notesCreate.run({ title: 'A & B', body: '<b>x</b>\ny' }, ctx);
    const body = calls[0]![1].at(-1)!;
    expect(body).toBe('<div><h1>A &amp; B</h1></div><div>&lt;b&gt;x&lt;/b&gt;<br>y</div>');
    expect(calls[0]![1].at(-2)).toBe('A & B');
  });

  it('reports a failed script', async () => {
    const { ctx } = mk({ results: [{ code: 1, stderr: 'execution error: Notes got an error' }] });
    const r = await notesCreate.run({ title: 't', body: 'b' }, ctx);
    expect(r).toEqual({ ok: false, reason: 'execution error: Notes got an error' });
  });
});

describe('messages_send', () => {
  it.each([
    ['text John saying I am running late', 'John', 'I am running late'],
    ['send a message to Sam Lee saying "see you at 5"', 'Sam Lee', 'see you at 5'],
    ['message mom: call me when you can', 'mom', 'call me when you can'],
    ['send "on my way" to Dad', 'Dad', 'on my way'],
    ['please text Priya that says happy birthday!', 'Priya', 'happy birthday!'],
  ])('matches %j', async (q, contact, text) => {
    expect(await messagesSend.extract(q, mk().ctx)).toEqual({ contact, text });
  });

  it.each([
    'send mom flowers',
    'message',
    'text me the weather',
    'send the report to the client',
    'I need to message John about the plan',
    'send a message',
    'text "$(rm -rf ~)" saying hi; ls',
  ])('does not match %j', async (q) => {
    expect(await messagesSend.extract(q, mk().ctx)).toBeNull();
  });

  it('asks the approval gate with a Send label before running anything', async () => {
    const order: string[] = [];
    const gate = vi.fn(async (label: string) => {
      order.push(`gate:${label}`);
    });
    const { ctx, calls } = mk({ gate });
    ctx.runner.run = vi.fn(async (f: string, a: string[]) => {
      order.push('run');
      calls.push([f, a]);
      return { code: 0, stdout: 'sent', stderr: '' };
    });
    const r = await messagesSend.run({ contact: 'John', text: 'hello there' }, ctx);
    expect(r).toEqual({ ok: true, summary: 'Sent your message to John' });
    expect(order).toEqual(['gate:Send message to John: hello there', 'run']);
  });

  it('truncates a long text in the approval label only', async () => {
    const gate = vi.fn(async () => {});
    const { ctx, calls } = mk({ gate });
    const long = 'x'.repeat(200);
    await messagesSend.run({ contact: 'John', text: long }, ctx);
    expect((gate.mock.calls[0] as unknown as [string])[0].length).toBeLessThan(110);
    expect(calls[0]![1].at(-2)).toBe(long);
  });

  it('stops without sending when the approval is rejected', async () => {
    const gate = vi.fn(async () => {
      throw new Error('Approval rejected by user. "Send message to John: hi" was not pressed.');
    });
    const { ctx, calls } = mk({ gate });
    const r = await messagesSend.run({ contact: 'John', text: 'hi' }, ctx);
    expect(r).toMatchObject({ ok: false, declined: true });
    expect(calls).toEqual([]);
  });

  it('never sends when no approval gate is available', async () => {
    const { ctx, calls } = mk();
    const r = await messagesSend.run({ contact: 'John', text: 'hi' }, ctx);
    expect(r).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it.each(HOSTILE)('passes hostile text %j only as argv', async (text) => {
    const gate = vi.fn(async () => {});
    const { ctx, calls } = mk({ gate });
    await messagesSend.run({ contact: 'John', text }, ctx);
    const args = calls[0]![1];
    const scriptArgs = args.slice(0, args.indexOf('--'));
    expect(scriptArgs.some((a) => a.includes(text))).toBe(false);
    expect(args.slice(args.indexOf('--') + 1)).toEqual([text, 'John']);
  });

  it('reports that the contact was not found', async () => {
    const gate = vi.fn(async () => {});
    const { ctx } = mk({ gate, results: [{ code: 1, stderr: "execution error: Messages got an error: Can't get buddy" }] });
    const r = await messagesSend.run({ contact: 'Nobody', text: 'hi' }, ctx);
    expect(r).toMatchObject({ ok: false });
  });
});

describe('set_volume', () => {
  it.each([
    ['set volume to 40', { action: 'set', value: '40' }],
    ['volume 75%', { action: 'set', value: '75' }],
    ['please set the volume to 100', { action: 'set', value: '100' }],
    ['volume up', { action: 'up' }],
    ['turn the volume down', { action: 'down' }],
    ['mute', { action: 'mute' }],
    ['unmute the sound', { action: 'unmute' }],
  ])('matches %j', async (q, slots) => {
    expect(await setVolume.extract(q, mk().ctx)).toEqual(slots);
  });

  it.each(['volume', 'set volume to loud', 'mute the meeting notes', 'what is the volume of a sphere', 'volume to 4000'])('does not match %j', async (q) => {
    expect(await setVolume.extract(q, mk().ctx)).toBeNull();
  });

  it('sets, clamps, and steps the volume with constant scripts', async () => {
    const a = mk();
    await setVolume.run({ action: 'set', value: '40' }, a.ctx);
    expect(a.calls).toEqual([['osascript', ['-e', 'set volume output volume 40']]]);

    const b = mk({ results: [{ stdout: '95\n' }, {}] });
    expect(await setVolume.run({ action: 'up' }, b.ctx)).toEqual({ ok: true, summary: 'Volume 100%' });
    expect(b.calls[1]).toEqual(['osascript', ['-e', 'set volume output volume 100']]);

    const c = mk({ results: [{ stdout: '5\n' }, {}] });
    expect(await setVolume.run({ action: 'down' }, c.ctx)).toEqual({ ok: true, summary: 'Volume 0%' });

    const d = mk();
    await setVolume.run({ action: 'mute' }, d.ctx);
    await setVolume.run({ action: 'unmute' }, d.ctx);
    expect(d.calls.map((c) => c[1][1])).toEqual(['set volume output muted true', 'set volume output muted false']);
  });

  it('refuses a non-numeric value even if called directly', async () => {
    const { ctx, calls } = mk();
    const r = await setVolume.run({ action: 'set', value: '1; do shell script "x"' }, ctx);
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('media', () => {
  it.each([
    ['pause', { verb: 'pause' }],
    ['pause the music', { verb: 'pause' }],
    ['play', { verb: 'play' }],
    ['resume playback', { verb: 'play' }],
    ['skip', { verb: 'next track' }],
    ['skip this song', { verb: 'next track' }],
    ['next track', { verb: 'next track' }],
    ['previous song', { verb: 'previous track' }],
    ['go back', { verb: 'previous track' }],
    ['pause spotify', { verb: 'pause', app: 'Spotify' }],
    ['play apple music', { verb: 'play', app: 'Music' }],
  ])('matches %j', async (q, slots) => {
    expect(await mediaControl.extract(q, mk().ctx)).toEqual(slots);
  });

  it.each(['play a song by Queen', 'play my liked songs on shuffle', 'pause for a moment and think', 'skip the intro of the video', 'play'.repeat(1) + ' football'])('does not match %j', async (q) => {
    expect(await mediaControl.extract(q, mk().ctx)).toBeNull();
  });

  it('controls the running player with constant AppleScript', async () => {
    const { ctx, calls } = mk({ results: [{ stdout: 'false\n' }, { stdout: 'true\n' }, {}] });
    const r = await mediaControl.run({ verb: 'pause' }, ctx);
    expect(r).toEqual({ ok: true, summary: 'Paused Music' });
    expect(calls.map((c) => c[1][1])).toEqual(['application "Spotify" is running', 'application "Music" is running', 'tell application "Music" to pause']);
  });

  it('prefers the player named in the request and launches it for play when nothing is running', async () => {
    const { ctx, calls } = mk({ results: [{}] });
    const r = await mediaControl.run({ verb: 'play', app: 'Spotify' }, ctx);
    expect(r).toEqual({ ok: true, summary: 'Playing Spotify' });
    expect(calls).toEqual([['osascript', ['-e', 'tell application "Spotify" to play']]]);
  });

  it('reports that nothing is playing for pause with no running player', async () => {
    const { ctx } = mk({ results: [{ stdout: 'false\n' }, { stdout: 'false\n' }] });
    expect(await mediaControl.run({ verb: 'pause' }, ctx)).toEqual({ ok: false, reason: 'No music player is running.' });
  });

  it('refuses a verb outside the allowlist', async () => {
    const { ctx, calls } = mk();
    expect((await mediaControl.run({ verb: 'quit" & (do shell script "x") & "' }, ctx)).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('defaultSkills', () => {
  it('registers every built-in with a unique id and a description', () => {
    const skills = defaultSkills();
    expect(skills.map((s) => s.id)).toEqual(['open_app', 'open_url', 'notes_create', 'messages_send', 'set_volume', 'media']);
    for (const s of skills) expect(s.description.length).toBeGreaterThan(10);
  });
});
