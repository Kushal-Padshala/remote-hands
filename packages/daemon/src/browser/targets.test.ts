import { describe, it, expect } from 'vitest';
import { resolveTarget } from './targets.js';
import type { PageElement, PageState } from './render.js';

const el = (id: number, role: string, label: string, extra: Partial<PageElement> = {}): PageElement => ({
  id, node: id, role, label, kind: role === 'textbox' ? 'fill' : 'click', ...extra,
});
const state = (elements: PageElement[], extra: Partial<PageState> = {}): PageState => ({
  url: 'https://x.test/', title: 'T', text: '', elements, ...extra,
});
const reason = (r: ReturnType<typeof resolveTarget>): string => (r.ok ? '' : r.reason);

describe('resolveTarget', () => {
  const page = state([
    el(1, 'textbox', 'Email address'),
    el(2, 'button', 'Email'),
    el(3, 'button', 'Next'),
    el(4, 'link', 'Next steps'),
    el(5, 'checkbox', 'I agree to the terms', { checked: false }),
    el(6, 'combobox', 'Country', { kind: 'select', value: 'US', options: ['US', 'Canada'] }),
    { id: 'wait', role: 'wait', label: 'Wait for the page to update', kind: 'wait' },
  ]);

  it('prefers an exact label match, ignoring case and spacing', () => {
    expect(resolveTarget(page, 'click', '  next ')).toMatchObject({ ok: true, el: { id: 3 } });
    expect(resolveTarget(page, 'check', 'i AGREE to the terms')).toMatchObject({ ok: true, el: { id: 5 } });
  });

  it('falls back to a unique label that starts with the target at a word boundary', () => {
    const p = state([el(1, 'textbox', 'Email address'), el(2, 'button', 'Send'), el(3, 'checkbox', 'Remember me, always', { checked: false })]);
    expect(resolveTarget(p, 'type', 'email')).toMatchObject({ ok: true, el: { id: 1 } });
    expect(resolveTarget(p, 'check', 'remember me')).toMatchObject({ ok: true, el: { id: 3 } });
  });

  it('does not match inside a word or in the middle of a label', () => {
    const p = state([el(1, 'textbox', 'Recovery email'), el(2, 'textbox', 'Emailing list'), el(3, 'checkbox', 'I agree to the terms', { checked: false })]);
    expect(resolveTarget(p, 'type', 'email')).toMatchObject({ ok: false });
    expect(resolveTarget(p, 'check', 'agree')).toMatchObject({ ok: false });
  });

  it('restricts candidates to the kind of element the op needs', () => {
    expect(resolveTarget(page, 'select', 'country')).toMatchObject({ ok: true, el: { id: 6 } });
    expect(resolveTarget(page, 'select', 'next')).toMatchObject({ ok: false });
  });

  it('refuses an exact label of the wrong kind instead of drifting to a partial match elsewhere', () => {
    const r = resolveTarget(page, 'type', 'email');
    expect(r).toMatchObject({ ok: false });
    expect(reason(r)).toBe('target "email" is not a text field here (it matches [2] button "Email"); use index');
    const recovery = state([el(1, 'button', 'Email'), el(2, 'textbox', 'Recovery email'), el(3, 'button', 'Save')]);
    expect(resolveTarget(recovery, 'type', 'Email')).toMatchObject({ ok: false });
  });

  it('refuses an ambiguous label and lists the candidates', () => {
    const p = state([el(1, 'button', 'Save draft'), el(2, 'button', 'Save changes'), el(3, 'button', 'Cancel')]);
    const r = resolveTarget(p, 'click', 'save');
    expect(reason(r)).toBe('target "save" is ambiguous (matches [1] button "Save draft", [2] button "Save changes"); use index');
    const dup = state([el(1, 'button', 'Save'), el(2, 'button', 'Save')]);
    expect(reason(resolveTarget(dup, 'click', 'Save'))).toBe('target "Save" is ambiguous (matches [1] button "Save", [2] button "Save"); use index');
  });

  it('reports a missing label with the closest elements', () => {
    const r = reason(resolveTarget(page, 'click', 'checkout now'));
    expect(r).toMatch(/^no element matches target "checkout now"/);
    expect(reason(resolveTarget(page, 'click', 'nexxt'))).toMatch(/^no element matches target "nexxt"/);
  });

  it('never targets pseudo lines such as wait or scroll', () => {
    expect(resolveTarget(page, 'click', 'wait')).toMatchObject({ ok: false });
  });

  it('rejects an empty target', () => {
    expect(resolveTarget(page, 'click', '   ')).toEqual({ ok: false, reason: 'target is empty' });
  });

  it('fails closed when the snapshot could not list every control', () => {
    const cut = state([el(1, 'button', 'Remove')], { omitted: 3 });
    expect(reason(resolveTarget(cut, 'click', 'Remove'))).toBe(
      'the page has more controls than could be listed (3 not listed), so a label cannot be proven unique; use browser_find to get an index',
    );
    const big = state([el(1, 'button', 'Remove')], { scanTruncated: true });
    expect(resolveTarget(big, 'click', 'Remove')).toMatchObject({ ok: false });
  });

  it('caps the candidate list at 5 and says how many more', () => {
    const many = state(Array.from({ length: 8 }, (_, i) => el(i + 1, 'button', `Save ${i}`)));
    const r = reason(resolveTarget(many, 'click', 'save'));
    expect(r).toContain('and 3 more');
    expect(r.match(/\[\d+\]/g)).toHaveLength(5);
  });
});

describe('resolveTarget word boundary (Unicode)', () => {
  const field = (label: string): PageState => state([el(1, 'textbox', label)]);

  it('treats a following letter outside the BMP or a combining mark as part of the word', () => {
    expect(resolveTarget(field('Email\u{1D55A}ng list'), 'type', 'email')).toMatchObject({ ok: false });
    expect(resolveTarget(field('Email\u0301 list'), 'type', 'email')).toMatchObject({ ok: false });
    expect(resolveTarget(field('Email'), 'type', 'email')).toMatchObject({ ok: true });
    expect(resolveTarget(field('Email: work'), 'type', 'email')).toMatchObject({ ok: true });
  });
});
