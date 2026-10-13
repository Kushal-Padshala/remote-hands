import { describe, it, expect } from 'vitest';
import { resolveTarget } from './targets.js';
import type { PageElement, PageState } from './render.js';

const el = (id: number, role: string, label: string, extra: Partial<PageElement> = {}): PageElement => ({
  id, node: id, role, label, kind: role === 'textbox' ? 'fill' : 'click', ...extra,
});
const state = (elements: PageElement[]): PageState => ({ url: 'https://x.test/', title: 'T', text: '', elements });

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
  });

  it('falls back to a unique substring match', () => {
    expect(resolveTarget(page, 'check', 'agree')).toMatchObject({ ok: true, el: { id: 5 } });
  });

  it('restricts candidates to the kind of element the op needs', () => {
    expect(resolveTarget(page, 'type', 'email')).toMatchObject({ ok: true, el: { id: 1 } });
    expect(resolveTarget(page, 'select', 'country')).toMatchObject({ ok: true, el: { id: 6 } });
    expect(resolveTarget(page, 'select', 'next')).toMatchObject({ ok: false });
  });

  it('refuses an ambiguous label and lists the candidates', () => {
    const r = resolveTarget(page, 'click', 'ema');
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toBe(
      'target "ema" is ambiguous (matches [1] textbox "Email address", [2] button "Email"); use index',
    );
  });

  it('reports a missing label with the closest elements', () => {
    const r = resolveTarget(page, 'click', 'checkout now');
    expect((r as { reason: string }).reason).toMatch(/^no element matches target "checkout now"/);
    const near = resolveTarget(page, 'click', 'nexxt');
    expect((near as { reason: string }).reason).toMatch(/^no element matches target "nexxt"/);
  });

  it('never targets pseudo lines such as wait or scroll', () => {
    expect(resolveTarget(page, 'click', 'wait')).toMatchObject({ ok: false });
  });

  it('rejects an empty target', () => {
    expect(resolveTarget(page, 'click', '   ')).toEqual({ ok: false, reason: 'target is empty' });
  });

  it('caps the candidate list at 5 and says how many more', () => {
    const many = state(Array.from({ length: 8 }, (_, i) => el(i + 1, 'button', `Save ${i}`)));
    const r = resolveTarget(many, 'click', 'save') as { reason: string };
    expect(r.reason).toContain('and 3 more');
    expect(r.reason.match(/\[\d+\]/g)).toHaveLength(5);
  });
});