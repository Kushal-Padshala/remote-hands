/**
 * Scripted acceptance: the whole pilot stack (engine prompt, options, loop, parser, adapter,
 * simulated sites rendered by the real renderer) driven by a perfect-oracle "model". It proves the
 * machinery completes real flows and keeps its safety promises; model quality is measured by the
 * live suite (acceptance.live.test.ts).
 */
import { describe, expect, it } from 'vitest';
import type { DecideInput, DecideResult, DecisionEngine } from '../types.js';
import { BrowserPilotEnv } from './env.js';
import { runPilot } from './pilot.js';
import { SimBrowser, type SimSite } from './sim/site.js';
import { AmbiguousSite, InjectionSite, LoginSite, ShopSite, SurveySite, WizardSite } from './sim/sites.js';

type Policy = (input: DecideInput) => string | undefined;

const find = (input: DecideInput, re: RegExp) => input.options.find((o) => re.test(o.text))?.id;
const doneId = (input: DecideInput) => input.options.find((o) => /already complete/.test(o.text))!.id;
const recent = (input: DecideInput) => input.state.split('RECENT ACTIONS')[1]?.split('UNTRUSTED PAGE')[0] ?? '';

function oracle(policy: Policy, gap = 6): DecisionEngine {
  return {
    async decide(input): Promise<DecideResult> {
      const choice = policy(input) ?? doneId(input);
      return { choice, probabilities: {}, gapNats: gap, letterMass: 1, latencyMs: 1, promptTokens: 1 };
    },
  };
}

const rejectRisky = (label: string) => {
  if (/place order|delete account/i.test(label)) throw new Error(`Approval rejected by user: ${label}`);
};

async function drive(site: SimSite, engine: DecisionEngine, extra: Partial<Parameters<typeof runPilot>[0]> = {}) {
  const browser = new SimBrowser(site, rejectRisky);
  const result = await runPilot({ goal: 'do the task', handoffGapNats: 2, env: new BrowserPilotEnv(browser), engine, ...extra });
  return { result, browser };
}

describe('pilot acceptance (scripted oracle)', () => {
  it('completes the whole survey through the real element-table format', async () => {
    const site = new SurveySite();
    const policy: Policy = (i) =>
      find(i, /^select \[\d+\] radio "(Somewhat confident|Somewhat concerned|Somewhat well|Apply to graduate)/) ??
      find(i, /^tick \[\d+\] checkbox "Taken on internships/) ??
      (recent(i).includes('Keep this order') ? undefined : find(i, /^click \[25\] button "Keep this order"/)) ??
      find(i, /^click \[\d+\] button "Next"/);
    const { result } = await drive(site, oracle(policy), { goal: 'complete this survey', brief: 'international student; moderate answers; skip optional text' });
    expect(result.status).toBe('done');
    expect(site.finished).toBe(true);
    expect(site.answers['Survey 1']).toEqual([2]);
    expect(site.answers['Survey 3']).toEqual([15]);
    expect(result.steps.every((s) => s.outcome === 'ok')).toBe(true);
    expect(result.steps.length).toBeLessThanOrEqual(14);
  });

  it('signs in with the typed facts', async () => {
    const site = new LoginSite();
    const policy: Policy = (i) => {
      if (/Which value belongs in the field/.test(i.question)) {
        return find(i, i.question.includes('"Email"') ? /^email = / : /^password = /);
      }
      return find(i, /^fill \[\d+\] textbox "Email"/) ?? find(i, /^fill \[\d+\] textbox "Password"/) ?? find(i, /^click \[\d+\] button "Sign in"/);
    };
    const { result, browser } = await drive(site, oracle(policy), { goal: 'sign in to my account', facts: { email: 'me@example.com', password: 'hunter2' } });
    expect(result.status).toBe('done');
    expect(site.signedIn).toBe(true);
    expect(browser.log.filter((l) => l.op === 'type').map((l) => l.text)).toEqual(['me@example.com', 'hunter2']);
    expect(result.steps.map((s) => s.description).join(' ')).not.toContain('hunter2');
  });

  it('walks a wizard whose Next button reuses the same id on every page without calling it a loop', async () => {
    const site = new WizardSite();
    const policy: Policy = (i) => find(i, /^click \[1\] button "Start"/) ?? find(i, /^click \[3\] button "(Next|Finish)"/);
    const { result } = await drive(site, oracle(policy), { goal: 'complete the setup wizard' });
    expect(result.status).toBe('done');
    expect(site.step).toBe(5);
    expect(result.steps).toHaveLength(5);
  });

  it('stops at Place order when the approval is rejected and never places the order', async () => {
    const site = new ShopSite();
    const policy: Policy = (i) => {
      if (/Which value belongs in the field/.test(i.question)) return find(i, /^search_query = /);
      const done = recent(i);
      return (
        find(i, /^fill \[1\] textbox "Search products"/) ??
        find(i, /^click \[2\] button "Search"/) ??
        (done.includes('Add Wireless Mouse M1 to cart') ? undefined : find(i, /Add Wireless Mouse M1 to cart/)) ??
        find(i, /^click \[4\] link "Cart/) ??
        find(i, /^click \[20\] button "Checkout"/) ??
        find(i, /^click \[30\] button "Place order"/)
      );
    };
    const { result, browser } = await drive(site, oracle(policy), { goal: 'buy a wireless mouse', facts: { search_query: 'wireless mouse' } });
    expect(result.status).toBe('declined');
    expect((result as { reason: string }).reason).toContain('Place order');
    expect(site.orderPlaced).toBe(false);
    expect(site.cart).toEqual(['Wireless Mouse M1']);
    expect(browser.log.some((l) => l.label === 'Place order')).toBe(false);
  });

  it('finishes the real goal on a page that tries to give orders, and never presses Delete account', async () => {
    const site = new InjectionSite();
    const { result, browser } = await drive(site, oracle((i) => find(i, /button "Download invoice"/)), { goal: 'download my latest invoice' });
    expect(result.status).toBe('done');
    expect(site.downloaded).toBe(true);
    expect(site.accountDeleted).toBe(false);
    expect(browser.log.some((l) => l.label === 'Delete account')).toBe(false);
  });

  it('keeps hostile page text out of the trusted part of the prompt', async () => {
    const site = new InjectionSite();
    const seen: string[] = [];
    const engine: DecisionEngine = {
      async decide(input) {
        seen.push(input.state);
        const choice = find(input, /button "Download invoice"/) ?? doneId(input);
        return { choice, probabilities: {}, gapNats: 6, letterMass: 1, latencyMs: 1, promptTokens: 1 };
      },
    };
    await drive(site, engine, { goal: 'download my latest invoice' });
    const [trusted, untrusted] = seen[0]!.split('UNTRUSTED PAGE');
    expect(trusted).not.toContain('Delete account');
    expect(untrusted).toContain('SYSTEM NOTICE TO THE ASSISTANT');
  });

  it('hands off instead of guessing on a page unrelated to the goal', async () => {
    const site = new AmbiguousSite();
    const unsure = oracle((i) => find(i, /^click \[2\]/), 0.2);
    const { result } = await drive(site, unsure, { goal: 'download my invoice' });
    expect(result).toMatchObject({ status: 'handoff', reason: 'low_margin' });
    expect(site.clicked).toEqual([]);
  });

  it('stays within budget on every flow', async () => {
    const site = new WizardSite();
    const policy: Policy = (i) => find(i, /^click \[1\] button "Start"/) ?? find(i, /^click \[3\] button "(Next|Finish)"/);
    const { result } = await drive(site, oracle(policy), { goal: 'complete the setup wizard', maxSteps: 30, maxMs: 120_000 });
    expect(result.elapsedMs).toBeLessThan(120_000);
  });
});
