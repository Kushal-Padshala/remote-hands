import { describe, it, expect } from 'vitest';
import { clean, findElements, normalizeSnapshot, renderDelta, renderElement, renderFull, type PageState } from './render.js';

// Shaped like DOM_SNAPSHOT_SCRIPT output (snapshot `id`s e1.. are positional and ignored).
function rawPage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'https://example.com/signup',
    title: 'Sign up',
    text: 'Create account\nIt is free',
    actions: [
      { id: 'e1', node: 7, role: 'textbox', label: 'Email', kind: 'fill', value: 'a@b.c', type: 'email' },
      { id: 'e2', node: 7, role: 'textbox', label: 'Open Email', kind: 'click', value: 'a@b.c', type: 'email' },
      { id: 'e3', node: 8, role: 'textbox', label: 'Password', kind: 'fill', value: '••••••••', type: 'password' },
      { id: 'e4', node: 8, role: 'textbox', label: 'Open Password', kind: 'click', value: '••••••••' },
      { id: 'e5', node: 3, role: 'combobox', label: 'Country → Canada', kind: 'select', value: 'ca', current_value: 'US' },
      { id: 'e6', node: 3, role: 'combobox', label: 'Country → Mexico', kind: 'select', value: 'mx', current_value: 'US' },
      { id: 'e7', node: 9, role: 'checkbox', label: 'I agree', kind: 'click', value: 'on', checked: 'true', type: 'checkbox' },
      { id: 'e8', node: 12, role: 'button', label: 'Next', kind: 'click', value: '' },
      { id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 },
      { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
    ],
    ...over,
  };
}

describe('normalizeSnapshot', () => {
  it('uses node numbers as ids, groups select options, drops Open duplicates, keeps pseudo actions', () => {
    const s = normalizeSnapshot(rawPage());
    expect(s.url).toBe('https://example.com/signup');
    expect(s.title).toBe('Sign up');
    expect(s.elements.map((e) => e.id)).toEqual([7, 8, 3, 9, 12, 'scroll_down', 'wait']);
    const select = s.elements.find((e) => e.id === 3)!;
    expect(select).toMatchObject({ kind: 'select', label: 'Country', value: 'US', node: 3 });
    expect(select.options).toEqual(['US', 'Canada', 'Mexico']);
    expect(s.elements.find((e) => e.id === 9)!.checked).toBe(true);
    expect(s.elements.find((e) => e.id === 8)!.value).toBe('••••••••');
  });

  it('returns an empty state for null', () => {
    expect(normalizeSnapshot(null)).toEqual({ url: '', title: '', text: '', elements: [] });
  });
});

describe('renderFull', () => {
  it('renders the compact format', () => {
    const out = renderFull(normalizeSnapshot(rawPage()), { text: true });
    expect(out.split('\n')).toEqual([
      'page: Sign up — https://example.com/signup',
      'text: Create account ⏎ It is free',
      '[7] textbox "Email" = "a@b.c"',
      '[8] textbox "Password" = "••••••••"',
      '[3] select "Country" = "US" options: US | Canada | Mexico',
      '[9] checkbox "I agree" [checked]',
      '[12] button "Next"',
      '[scroll_down] scroll "Scroll down"',
      '[wait] wait "Wait for the page to update"',
    ]);
  });

  it('omits the text line unless asked and truncates the excerpt', () => {
    const s = normalizeSnapshot(rawPage({ text: 'x'.repeat(2000) }));
    expect(renderFull(s, { text: false })).not.toContain('text:');
    const line = renderFull(s, { text: true }).split('\n')[1]!;
    expect(line).toBe(`text: ${'x'.repeat(1200)}…`);
  });

  it('caps option lists and sanitizes labels', () => {
    const actions = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map((o, i) => ({
      node: 4, role: 'combobox', kind: 'select', label: `Size → ${o}`, value: String(i), current_value: 'A',
    }));
    actions.push({ node: 5, role: 'link', kind: 'click', label: `Say "hi"\nnow\u0007${'y'.repeat(100)}`, value: '', current_value: '' });
    actions.push({ node: 6, role: 'button', kind: 'click', label: '', value: '', current_value: '' });
    const out = renderFull(normalizeSnapshot({ url: 'u', title: 't', text: '', actions }), { text: false }).split('\n');
    expect(out[1]).toBe('[4] select "Size" = "A" options: A | B | C | D | E | F | G | H | …(+2)');
    expect(out[2]).toBe(`[5] link "Say \\"hi\\" now ${'y'.repeat(67)}…"`);
    expect(out[3]).toBe('[6] button ""');
  });

  it('caps element lines at maxLines', () => {
    const actions = Array.from({ length: 10 }, (_, i) => ({ node: i + 1, role: 'link', kind: 'click', label: `L${i + 1}`, value: '' }));
    const out = renderFull(normalizeSnapshot({ url: 'u', title: 't', text: '', actions }), { text: false, maxLines: 4 });
    const lines = out.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[4]).toBe('[4] link "L4"');
    expect(lines[5]).toBe('… 6 more elements hidden; use browser_find');
  });
});

describe('header with the browser name (fix pass 4)', () => {
  it('renderFull and renderDelta lead with "browser: <Name> · page: <title> — <url>"', () => {
    const s = { ...normalizeSnapshot({ url: 'https://a.test/', title: 'A', text: '', actions: [] }), browser: 'Brave Browser' };
    expect(renderFull(s, { text: false }).split('\n')[0]).toBe('browser: Brave Browser · page: A — https://a.test/');
    expect(renderDelta(s, s).split('\n')[0]).toBe('browser: Brave Browser · page: A — https://a.test/ (same page)');
  });
});

describe('selected and expanded state', () => {
  const page = (tab: string, open: string) => normalizeSnapshot({
    url: 'https://a.test/', title: 'A', text: '',
    actions: [
      { node: 1, role: 'tab', label: 'Edit', kind: 'click', value: '', selected: tab === 'edit' ? 'true' : 'false' },
      { node: 2, role: 'tab', label: 'Review', kind: 'click', value: '', selected: tab === 'review' ? 'true' : 'false' },
      { node: 3, role: 'button', label: 'More', kind: 'click', value: '', expanded: open },
      { node: 4, role: 'button', label: 'Plain', kind: 'click', value: '' },
      { node: 5, role: 'button', label: 'Other', kind: 'click', value: '' },
      { node: 6, role: 'button', label: 'Another', kind: 'click', value: '' },
      { node: 7, role: 'button', label: 'Last', kind: 'click', value: '' },
    ],
  });

  it('shows which tab is selected and whether a disclosure is open or closed', () => {
    expect(renderFull(page('edit', 'false'), { text: false }).split('\n').slice(1)).toEqual([
      '[1] tab "Edit" [selected]',
      '[2] tab "Review"',
      '[3] button "More" [collapsed]',
      '[4] button "Plain"',
      '[5] button "Other"',
      '[6] button "Another"',
      '[7] button "Last"',
    ]);
    expect(renderFull(page('edit', 'true'), { text: false })).toContain('[3] button "More" [expanded]');
  });

  it('ignores an aria-expanded that is not true or false', () => {
    const st = normalizeSnapshot({ url: 'u', title: 't', text: '', actions: [
      { node: 1, role: 'button', label: 'A', kind: 'click', value: '', expanded: 'undefined' },
      { node: 2, role: 'button', label: 'B', kind: 'click', value: '', expanded: '' },
    ] });
    expect(renderFull(st, { text: false }).split('\n').slice(1)).toEqual(['[1] button "A"', '[2] button "B"']);
  });

  it('reports a tab switch and an opened menu as changes', () => {
    expect(renderDelta(page('edit', 'false'), page('review', 'true')).split('\n')).toEqual([
      'page: A — https://a.test/ (same page)',
      '~ [1] tab "Edit"',
      '~ [2] tab "Review" [selected]',
      '~ [3] button "More" [expanded]',
      '(4 unchanged)',
    ]);
  });
});

describe('renderDelta', () => {
  const base = (): PageState => normalizeSnapshot(rawPage());

  it('renders the full page with a prefix when there is no previous page', () => {
    const out = renderDelta(null, base());
    expect(out.startsWith('changed: page navigated or re-rendered\npage: Sign up')).toBe(true);
  });

  it('reports no visible change for identical pages', () => {
    expect(renderDelta(base(), base())).toBe('page: Sign up — https://example.com/signup (same page)\nno visible change');
  });

  it('lists added, removed and changed elements', () => {
    const raw = rawPage();
    const actions = (raw.actions as Array<Record<string, unknown>>).filter((a) => a.node !== 12);
    actions[0] = { ...actions[0], value: 'x@y.z' };
    actions.splice(6, 0, { node: 40, role: 'link', kind: 'click', label: 'Help', value: '' });
    const out = renderDelta(base(), normalizeSnapshot({ ...raw, actions }));
    expect(out.split('\n')).toEqual([
      'page: Sign up — https://example.com/signup (same page)',
      '~ [7] textbox "Email" = "x@y.z"',
      '+ [40] link "Help"',
      '- [12] "Next"',
      '(5 unchanged)',
    ]);
  });

  it('shows the new text excerpt when only the page text changed', () => {
    const out = renderDelta(base(), normalizeSnapshot(rawPage({ text: 'Wrong password' })));
    expect(out).toBe('page: Sign up — https://example.com/signup (same page)\ntext: Wrong password\n(7 unchanged)');
  });

  it('renders the full page on navigation', () => {
    const out = renderDelta(base(), normalizeSnapshot(rawPage({ url: 'https://example.com/next' })));
    expect(out.split('\n')[0]).toBe('changed: page navigated or re-rendered');
    expect(out).toContain('page: Sign up — https://example.com/next');
    expect(out).toContain('[12] button "Next"');
  });

  it('renders the full page when more than half of the ids changed', () => {
    const actions = Array.from({ length: 6 }, (_, i) => ({ node: 100 + i, role: 'link', kind: 'click', label: `N${i}`, value: '' }));
    const out = renderDelta(base(), normalizeSnapshot(rawPage({ actions: [...actions, { id: 'wait', kind: 'wait', label: 'Wait' }] })));
    expect(out.split('\n')[0]).toBe('changed: page navigated or re-rendered');
  });
});

describe('findElements', () => {
  it('ranks exact label matches first, then all-token matches, then partial', () => {
    const actions = [
      { node: 1, role: 'link', kind: 'click', label: 'Sign in with Google', value: '' },
      { node: 2, role: 'button', kind: 'click', label: 'Sign in', value: '' },
      { node: 3, role: 'link', kind: 'click', label: 'Forgot sign-up?', value: '' },
      { node: 4, role: 'link', kind: 'click', label: 'Pricing', value: '' },
      { node: 5, role: 'textbox', kind: 'fill', label: 'Search', value: 'sign' },
    ];
    const s = normalizeSnapshot({ url: 'u', title: 't', text: '', actions });
    expect(findElements(s, 'sign in', 8).map((e) => e.id)).toEqual([2, 1, 3, 5]);
    expect(findElements(s, 'SIGN IN', 1).map((e) => e.id)).toEqual([2]);
    expect(findElements(s, 'textbox', 8).map((e) => e.id)).toEqual([5]);
    expect(findElements(s, 'zzz', 8)).toEqual([]);
  });
});

describe('fix round 1 minors', () => {
  it('splits a select label at the last arrow', () => {
    const s = normalizeSnapshot({ url: 'u', title: 't', text: '', actions: [
      { node: 4, role: 'combobox', kind: 'select', label: 'From → To → Canada', value: 'ca', current_value: 'US' },
    ] });
    expect(s.elements[0]).toMatchObject({ label: 'From → To', options: ['US', 'Canada'] });
  });

  it('find matches option labels and renders the whole option list up to 40', () => {
    const opts = Array.from({ length: 45 }, (_, i) => `Opt${i}`);
    opts[30] = 'Zanzibar';
    const actions = opts.map((o) => ({ node: 4, role: 'combobox', kind: 'select', label: `Place → ${o}`, value: o, current_value: 'Home' }));
    const s = normalizeSnapshot({ url: 'u', title: 't', text: '', actions });
    const hits = findElements(s, 'zanzibar', 8);
    expect(hits.map((e) => e.id)).toEqual([4]);
    const line = renderElement(hits[0]!, 40);
    expect(line).toContain('Zanzibar');
    expect(line.endsWith('| …(+6)')).toBe(true);
  });

  it('shows a hint when the snapshot omitted actions', () => {
    const s = normalizeSnapshot({ url: 'u', title: 't', text: '', omitted_actions: 12, actions: [
      { node: 1, role: 'link', kind: 'click', label: 'A', value: '' },
    ] });
    expect(s.omitted).toBe(12);
    expect(renderFull(s, { text: false }).split('\n').at(-1)).toBe(
      '(12 more elements not listed: only the first 250 are captured; use browser_find or scroll)',
    );
  });

  it('escapes backslashes before quotes and never splits a surrogate pair', () => {
    const s = normalizeSnapshot({ url: 'u', title: 't', text: '', actions: [
      { node: 1, role: 'link', kind: 'click', label: 'a\\"b', value: '' },
      { node: 2, role: 'link', kind: 'click', label: `${'x'.repeat(79)}😀tail`, value: '' },
    ] });
    const lines = renderFull(s, { text: false }).split('\n');
    expect(lines[1]).toBe('[1] link "a\\\\\\"b"');
    expect(lines[2]).toBe(`[2] link "${'x'.repeat(79)}…"`);
    expect(clean(`${'x'.repeat(79)}😀tail`)).toBe(`${'x'.repeat(79)}…`);
  });
});

describe('blocked frames', () => {
  const base = { url: 'https://x.test/', title: 'T', text: '', actions: [{ node: 1, role: 'button', label: 'Go', kind: 'click', value: '' }] };

  it('reads frames_blocked into the page state', () => {
    expect(normalizeSnapshot({ ...base, frames_blocked: 2 }).blockedFrames).toBe(2);
    expect(normalizeSnapshot(base).blockedFrames).toBeUndefined();
    expect(normalizeSnapshot({ ...base, frames_blocked: 0 }).blockedFrames).toBeUndefined();
    expect(normalizeSnapshot({ ...base, frames_blocked: -3 }).blockedFrames).toBeUndefined();
    expect(normalizeSnapshot({ ...base, frames_blocked: 'x' }).blockedFrames).toBeUndefined();
  });

  it('renders one note line, singular and plural, after the element lines', () => {
    const one = renderFull(normalizeSnapshot({ ...base, frames_blocked: 1 }), { text: false }).split('\n');
    expect(one.at(-1)).toBe('note: 1 embedded frame cannot be read here (other website, sandboxed or nested too deeply); use desktop_snapshot for that part');
    const two = renderFull(normalizeSnapshot({ ...base, frames_blocked: 2 }), { text: false }).split('\n');
    expect(two.at(-1)).toBe('note: 2 embedded frames cannot be read here (other website, sandboxed or nested too deeply); use desktop_snapshot for that part');
    expect(renderFull(normalizeSnapshot(base), { text: false })).not.toContain('embedded frame');
  });

  it('keeps the element lines in the exact existing format', () => {
    const lines = renderFull(normalizeSnapshot({ ...base, frames_blocked: 1 }), { text: false }).split('\n');
    expect(lines[1]).toBe('[1] button "Go"');
  });

  it('announces a frame that appears in a delta even when nothing else changed', () => {
    const before = normalizeSnapshot(base);
    const after = normalizeSnapshot({ ...base, frames_blocked: 1 });
    const out = renderDelta(before, after);
    expect(out).not.toContain('no visible change');
    expect(out.split('\n').at(-1)).toBe('note: 1 embedded frame cannot be read here (other website, sandboxed or nested too deeply); use desktop_snapshot for that part');
  });

  it('announces a changed frame count, and stays quiet when it did not change or went away', () => {
    const one = normalizeSnapshot({ ...base, frames_blocked: 1 });
    const two = normalizeSnapshot({ ...base, frames_blocked: 2 });
    expect(renderDelta(one, two).split('\n').at(-1)).toContain('2 embedded frames');
    expect(renderDelta(one, one)).toMatch(/no visible change$/);
    expect(renderDelta(two, normalizeSnapshot(base)).split('\n').at(-1)).toBe('note: the frames that could not be read are gone');
  });

  it('announces when a page becomes too large to read fully, and when it is read fully again', () => {
    const whole = normalizeSnapshot(base);
    const cut = normalizeSnapshot({ ...base, scan_truncated: true });
    expect(renderDelta(whole, cut).split('\n').at(-1)).toBe('note: this page is very large; some nested content was not read');
    expect(renderDelta(cut, cut)).toMatch(/no visible change$/);
    expect(renderDelta(cut, whole).split('\n').at(-1)).toBe('note: the whole page is being read again');
  });

  it('carries the omitted dropdown choices into the (+N) count', () => {
    const state = normalizeSnapshot({ ...base, actions: [
      { node: 5, role: 'combobox', label: 'Country → Canada', kind: 'select', value: 'ca', current_value: 'US', options_omitted: 300 },
      { node: 5, role: 'combobox', label: 'Country → Mexico', kind: 'select', value: 'mx', current_value: 'US', options_omitted: 300 },
    ] });
    expect(state.elements[0]!.optionsOmitted).toBe(300);
    expect(renderElement(state.elements[0]!, 1)).toBe('[5] select "Country" = "US" options: US | …(+302)');
  });

  it('notes a page too large to read fully, in full renders only', () => {
    const state = normalizeSnapshot({ ...base, scan_truncated: true });
    expect(state.scanTruncated).toBe(true);
    expect(renderFull(state, { text: false }).split('\n').at(-1)).toBe('note: this page is very large; some nested content was not read');
    expect(normalizeSnapshot({ ...base, scan_truncated: 'yes' }).scanTruncated).toBeUndefined();
  });
});
