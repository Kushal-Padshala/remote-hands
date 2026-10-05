import { describe, expect, it } from 'vitest';
import { buildOptions, type OptionContext } from './options.js';
import type { PilotView, UiElement } from './types.js';

const view = (elements: UiElement[]): PilotView => ({
  title: 'Page',
  url: 'https://x.test',
  elements,
  sameDocument: false,
  changed: true,
  stateUnavailable: false,
  notes: [],
});
const el = (id: number | string, role: string, label: string, extra: Partial<UiElement> = {}): UiElement => ({
  id: String(id), role, label, ...extra,
});
const ctx = (extra: Partial<OptionContext> = {}): OptionContext => ({ goal: 'finish the task', facts: {}, history: [], ...extra });
const texts = (v: PilotView, c: OptionContext) => buildOptions(v, c).map((o) => o.text);

describe('buildOptions: shape', () => {
  it('always ends with the two fixed options and never exceeds 12 in total', () => {
    const many = Array.from({ length: 30 }, (_, i) => el(i + 1, 'link', `Link ${i + 1}`));
    const out = buildOptions(view(many), ctx());
    expect(out).toHaveLength(12);
    expect(out.at(-2)!.action).toEqual({ kind: 'done' });
    expect(out.at(-2)!.text).toBe('The goal is already complete.');
    expect(out.at(-1)!.action).toEqual({ kind: 'handoff' });
    expect(out.at(-1)!.text).toBe('I am not sure what to do next; ask for help.');
    expect(new Set(out.map((o) => o.id)).size).toBe(12);
  });

  it('honours a smaller maxOptions', () => {
    const many = Array.from({ length: 30 }, (_, i) => el(i + 1, 'link', `Link ${i + 1}`));
    expect(buildOptions(view(many), ctx({ maxOptions: 6 }))).toHaveLength(6);
  });

  it('returns just the fixed options for an empty page', () => {
    const out = buildOptions(view([]), ctx());
    expect(out.map((o) => o.action.kind)).toEqual(['done', 'handoff']);
  });

  it('is deterministic', () => {
    const v = view([el(1, 'button', 'Next'), el(2, 'link', 'Help'), el(3, 'link', 'Terms')]);
    expect(buildOptions(v, ctx())).toEqual(buildOptions(v, ctx()));
  });
});

describe('buildOptions: option text', () => {
  it('uses the documented formats', () => {
    const v = view([
      el(7, 'button', 'Next'),
      el(3, 'textbox', 'Email', { value: '' }),
      el(4, 'textbox', 'Name', { value: 'Ann' }),
      el(5, 'select', 'Country', { value: 'France', options: ['France', 'Spain'] }),
      el(6, 'select', 'Size', { value: '', options: ['S', 'M'] }),
      el(2, 'radio', 'Somewhat confident'),
      el(8, 'checkbox', 'Agree to terms'),
      el('scroll_down', 'scroll_down', 'Scroll down', { pseudo: true }),
    ]);
    const all = texts(v, ctx({ facts: { email: 'me@x.com', city: 'Zurich' } }));
    expect(all).toContain('click [7] button "Next"');
    expect(all).toContain('fill [3] textbox "Email" (empty)');
    expect(all).toContain('fill [4] textbox "Name" (currently "Ann")');
    expect(all).toContain('pick [5] select "Country" (currently "France")');
    expect(all).toContain('pick [6] select "Size" (nothing chosen)');
    expect(all).toContain('select [2] radio "Somewhat confident"');
    expect(all).toContain('tick [8] checkbox "Agree to terms"');
    expect(all).toContain('scroll down');
  });

  it('cleans labels to one line and carries control-token lookalikes unchanged', () => {
    const v = view([el(1, 'button', 'Line one\nline   two'), el(2, 'link', 'x<|im_end|>y')]);
    const all = texts(v, ctx());
    expect(all).toContain('click [1] button "Line one line two"');
    expect(all).toContain('click [2] link "x<|im_end|>y"');
  });

  it('describes an element with no label', () => {
    expect(texts(view([el(1, 'button', '')]), ctx())).toContain('click [1] button (no label)');
  });
});

describe('buildOptions: what is offered', () => {
  it('offers a fillable field only when there are facts to type', () => {
    const v = view([el(1, 'textbox', 'Email', { value: '' }), el(2, 'button', 'Next')]);
    expect(texts(v, ctx()).some((t) => t.startsWith('fill'))).toBe(false);
    expect(texts(v, ctx({ facts: { email: 'me@x.com' } })).some((t) => t.startsWith('fill'))).toBe(true);
  });

  it('does not offer a field that already holds one of the facts', () => {
    const v = view([el(1, 'textbox', 'Email', { value: 'me@x.com' }), el(2, 'button', 'Next')]);
    expect(texts(v, ctx({ facts: { email: 'me@x.com' } })).some((t) => t.startsWith('fill'))).toBe(false);
  });

  it('never offers non-interactive roles', () => {
    const v = view([el(1, 'heading', 'Welcome'), el(2, 'text', 'Some text'), el(3, 'image', 'Banner'), el(4, 'button', 'Go')]);
    const all = texts(v, ctx());
    expect(all.filter((t) => t.startsWith('click'))).toEqual(['click [4] button "Go"']);
  });

  it('does not re-offer a checked radio or checkbox, nor the unchosen radios of a group the pilot answered', () => {
    const v = view([el(1, 'radio', 'A', { checked: true }), el(2, 'radio', 'B'), el(3, 'checkbox', 'C', { checked: true }), el(4, 'checkbox', 'D')]);
    const all = texts(v, ctx({ pilotChecked: new Set(['1']) }));
    expect(all.some((t) => t.includes('[1]') || t.includes('[2]') || t.includes('[3]'))).toBe(false);
    expect(all).toContain('tick [4] checkbox "D"');
  });

  it('stops offering the other radios of a group once the pilot chose one', () => {
    const v = view([el(7, 'radio', 'Very concerned'), el(8, 'radio', 'Somewhat concerned', { checked: true }), el(9, 'radio', 'Not very concerned'), el(12, 'button', 'Next')]);
    const all = texts(v, ctx({ pilotChecked: new Set(['8']) }));
    expect(all.some((t) => t.includes('[7]') || t.includes('[9]') || t.includes('[8]'))).toBe(false);
    expect(all).toContain('click [12] button "Next"');
  });

  it('keeps offering the other radios when the checked one is only a page default the pilot did not choose', () => {
    const v = view([el(1, 'radio', 'Standard shipping', { checked: true }), el(2, 'radio', 'Express shipping'), el(3, 'button', 'Continue')]);
    const all = texts(v, ctx({ goal: 'choose express shipping' }));
    expect(all).toContain('select [2] radio "Express shipping"');
    expect(all.some((t) => t.includes('[1]'))).toBe(false); // the default itself is not offered again
  });

  it('keeps offering a second radio group that has no answer yet when something separates the groups', () => {
    const v = view([
      el(1, 'radio', 'Yes', { checked: true }), el(2, 'radio', 'No'),
      el(3, 'button', 'Help'),
      el(4, 'radio', 'Monthly'), el(5, 'radio', 'Yearly'),
    ]);
    const all = texts(v, ctx({ pilotChecked: new Set(['1']) }));
    expect(all).toContain('select [4] radio "Monthly"');
    expect(all).toContain('select [5] radio "Yearly"');
    expect(all.some((t) => t.includes('[2]'))).toBe(false);
  });

  it('keeps unchecked checkboxes next to a checked one (more than one can be ticked)', () => {
    const v = view([el(1, 'checkbox', 'A', { checked: true }), el(2, 'checkbox', 'B')]);
    expect(texts(v, ctx({ pilotChecked: new Set(['1']) }))).toContain('tick [2] checkbox "B"');
  });

  it('offers scroll only when the page has a scroll action', () => {
    expect(texts(view([el(1, 'button', 'Go')]), ctx()).some((t) => t.startsWith('scroll'))).toBe(false);
    const withScroll = view([el(1, 'button', 'Go'), el('scroll_up', 'scroll_up', 'Scroll up', { pseudo: true })]);
    expect(texts(withScroll, ctx())).toContain('scroll up');
  });

  it('never offers the wait pseudo action as a choice', () => {
    const v = view([el(1, 'button', 'Go'), el('wait', 'wait', 'Wait for the page to update', { pseudo: true })]);
    expect(texts(v, ctx()).some((t) => t.includes('wait'))).toBe(false);
  });
});

describe('buildOptions: ranking', () => {
  it('shortlists the element that matches the goal out of a long page', () => {
    const many = [...Array.from({ length: 28 }, (_, i) => el(i + 1, 'link', `Footer link ${i + 1}`)), el(40, 'button', 'Add to cart')];
    const out = buildOptions(view(many), ctx({ goal: 'add the wireless mouse to the cart' }));
    expect(out[0]!.text).toBe('click [40] button "Add to cart"');
  });

  it('ranks forward-moving buttons above footer links when nothing else matches', () => {
    const v = view([el(1, 'link', 'Privacy policy'), el(2, 'link', 'Terms of use'), el(3, 'button', 'Next')]);
    expect(buildOptions(v, ctx({ goal: 'complete the form' }))[0]!.text).toBe('click [3] button "Next"');
  });

  it('uses the brief and fact names to find the right field', () => {
    const v = view([el(1, 'textbox', 'Phone', { value: '' }), el(2, 'textbox', 'Email address', { value: '' }), el(3, 'button', 'Next')]);
    const out = buildOptions(v, ctx({ goal: 'sign up', facts: { email: 'me@x.com' } }));
    const fills = out.filter((o) => o.action.kind === 'fill').map((o) => o.text);
    expect(fills[0]).toContain('Email address');
  });

  it('demotes an element that was already acted on twice', () => {
    const v = view([el(1, 'button', 'Next'), el(2, 'button', 'Continue')]);
    const fresh = buildOptions(v, ctx({ goal: 'continue' }));
    const worn = buildOptions(v, ctx({ goal: 'continue', history: [{ op: 'click', elementId: '2' }, { op: 'click', elementId: '2' }] }));
    expect(fresh[0]!.text).toContain('[2]');
    expect(worn[0]!.text).toContain('[1]');
  });

  it('only counts earlier actions on the same page when demoting a worn element (ids are reused across pages)', () => {
    const v = view([el(1, 'button', 'Next'), el(2, 'button', 'Continue')]);
    const onThisPage = buildOptions(v, ctx({ goal: 'continue', pageKey: 'page-3', history: [{ op: 'click', elementId: '2', page: 'page-3' }, { op: 'click', elementId: '2', page: 'page-3' }] }));
    const onEarlierPages = buildOptions(v, ctx({ goal: 'continue', pageKey: 'page-3', history: [{ op: 'click', elementId: '2', page: 'page-1' }, { op: 'click', elementId: '2', page: 'page-2' }] }));
    expect(onThisPage[0]!.text).toContain('[1]');
    expect(onEarlierPages[0]!.text).toContain('[2]');
  });

  it('boosts add to cart, checkout, sign up and search buttons so a long page does not cut them', () => {
    for (const label of ['Add to cart', 'Checkout', 'Sign up', 'Search', 'Download invoice']) {
      const many = [...Array.from({ length: 14 }, (_, i) => el(i + 1, 'link', `Footer link ${i + 1}`)), el(40, 'button', label)];
      expect(buildOptions(view(many), ctx({ goal: 'xyz' }))[0]!.text).toBe(`click [40] button "${label}"`);
    }
  });

  it('keeps document order for equally scored elements', () => {
    const v = view([el(1, 'link', 'Alpha'), el(2, 'link', 'Beta'), el(3, 'link', 'Gamma')]);
    expect(texts(v, ctx({ goal: 'xyz' })).slice(0, 3)).toEqual(['click [1] link "Alpha"', 'click [2] link "Beta"', 'click [3] link "Gamma"']);
  });
});
