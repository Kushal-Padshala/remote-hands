import { describe, expect, it } from 'vitest';
import { parseRendered } from '../parse.js';
import { SimBrowser } from './site.js';
import { LoginSite, SurveySite, WizardSite } from './sites.js';

describe('SimBrowser', () => {
  it('renders the first page in the engine format, with text only when asked', async () => {
    const b = new SimBrowser(new SurveySite());
    const plain = await b.browserSnapshot();
    expect(plain).toContain('browser: Google Chrome · page: Survey 1 — https://sim.test/survey-1');
    expect(plain).toContain('[2] radio "Somewhat confident"');
    expect(plain).toContain('[wait] wait "Wait for the page to update"');
    expect(plain).not.toContain('text:');
    expect(await b.browserSnapshot({ text: true })).toContain('text: How confident are you');
  });

  it('answers actions with "did:" plus a delta against the previous page, like the engine', async () => {
    const b = new SimBrowser(new SurveySite());
    await b.browserSnapshot();
    const out = await b.browserDo([{ op: 'check', index: 2, checked: true }]);
    expect(out.startsWith('did: check\n')).toBe(true);
    expect(out).toContain('(same page)');
    expect(out).toContain('~ [2] radio "Somewhat confident" [checked]');
  });

  it('reports a full page after the page changes', async () => {
    const b = new SimBrowser(new SurveySite());
    await b.browserSnapshot();
    await b.browserDo([{ op: 'check', index: 2, checked: true }]);
    const out = await b.browserDo([{ op: 'click', index: 6 }]);
    expect(out).toContain('changed: page navigated or re-rendered');
    expect(out).toContain('[7] radio "Very concerned"');
  });

  it('says "no visible change" when nothing happened (Next with no answer)', async () => {
    const b = new SimBrowser(new SurveySite());
    await b.browserSnapshot();
    expect(await b.browserDo([{ op: 'click', index: 6 }])).toContain('no visible change');
  });

  it('fails on an id that is not on the page, in the engine\'s wording', async () => {
    const b = new SimBrowser(new WizardSite());
    await b.browserSnapshot();
    await expect(b.browserDo([{ op: 'click', index: 99 }])).rejects.toThrow('step 1 click failed: element [99] is not on the page');
  });

  it('asks the gate before every click and a rejection stops the action', async () => {
    const asked: string[] = [];
    const site = new LoginSite();
    const b = new SimBrowser(site, (label) => {
      asked.push(label);
      if (label === 'Sign in') throw new Error('Approval rejected by user: no');
    });
    await b.browserSnapshot();
    await b.browserDo([{ op: 'type', index: 1, text: 'me@example.com' }]);
    await expect(b.browserDo([{ op: 'click', index: 3 }])).rejects.toThrow('Approval rejected by user');
    expect(asked).toEqual(['Sign in']);
    expect(b.log.filter((l) => l.op === 'click')).toEqual([]); // the click never reached the page
  });

  it('keeps a log of every action that reached the page', async () => {
    const b = new SimBrowser(new LoginSite());
    await b.browserSnapshot();
    await b.browserDo([{ op: 'type', index: 1, text: 'a@b.c' }, { op: 'type', index: 2, text: 'pw' }]);
    expect(b.log).toEqual([
      { op: 'type', id: 1, label: 'Email', text: 'a@b.c' },
      { op: 'type', id: 2, label: 'Password', text: 'pw' },
    ]);
  });

  it('produces text the pilot parser reads back into the same elements', async () => {
    const b = new SimBrowser(new SurveySite());
    const view = parseRendered(await b.browserSnapshot({ text: true }));
    expect(view.elements.map((e) => e.id)).toEqual(['1', '2', '3', '4', '5', '6', 'wait']);
    expect(view.title).toBe('Survey 1');
  });
});
