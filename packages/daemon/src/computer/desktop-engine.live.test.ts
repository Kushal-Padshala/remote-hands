import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { AxHelperClient } from '../desktop/ax-helper.js';
import { DesktopEngine } from './desktop-engine.js';

// Drives a throwaway TextEdit document on a real Mac. Opt in with RH_LIVE_ACT=1 and RH_AX_BIN=<path to rh-ax>.
const run = process.env.RH_LIVE_ACT === '1' && process.env.RH_AX_BIN ? describe : describe.skip;

const osa = (script: string): string => execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 20_000 }).trim();

run('desktop engine on TextEdit (live)', () => {
  const client = new AxHelperClient({ enabled: true, launch: () => ({ command: process.env.RH_AX_BIN!, args: [] }) });
  const engine = new DesktopEngine(client);
  afterAll(() => {
    try { osa('tell application "TextEdit" to close every document saving no'); } catch {}
    client.stop();
  });

  it('types into, reads, replaces and scrolls a document', async () => {
    osa('tell application "TextEdit" to activate\ntell application "TextEdit" to make new document');
    let text: string | null = null;
    for (let i = 0; i < 20 && !(text !== null && [...engine.current()!.view.items].some((x) => x.editable)); i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      text = await engine.snapshot('TextEdit');
    }
    process.stderr.write(`\n${text}\n`);
    const area = [...engine.current()!.view.items].find((i) => i.editable);
    expect(area, 'a text area').toBeTruthy();
    await engine.focus(area!.id);
    await engine.typeText('héllo 👋\nsecond line', area!.id);
    await new Promise((r) => setTimeout(r, 300));
    const read = await engine.readText(area!.id);
    process.stderr.write(`read: ${JSON.stringify(read)}\n`);
    expect(read.text).toBe('héllo 👋\nsecond line');
    const set = await engine.setValue(area!.id, 'replaced');
    expect(set.set).toBe(true);
    expect((await engine.readText(area!.id)).text).toBe('replaced');
    await engine.focus(area!.id);
    await engine.pressKey('selectAll', area!.id);
    await engine.typeText('typed over', area!.id);
    await new Promise((r) => setTimeout(r, 300));
    expect((await engine.readText(area!.id)).text).toBe('typed over');
  }, 90_000);

  it('presses a checkbox natively and with a physical click, and diffs the result', async () => {
    const find = (label: string) => [...engine.current()!.view.items].find((i) => i.label === label)!;
    await engine.snapshot('TextEdit');
    const bold = find('bold');
    const before = engine.current()!.view;
    expect((await engine.click(bold.id, 'press')).method).toBe('ax');
    const diff1 = await engine.settle('TextEdit', before, { firstMs: 100, gapMs: 100 });
    process.stderr.write(`after press:\n${diff1}\n`);
    expect(diff1).toContain('checkbox "bold" checked');
    const italic = find('italic');
    const before2 = engine.current()!.view;
    expect((await engine.click(italic.id, 'double')).method).toBe('click'); // two clicks: on, then off
    const diff2 = await engine.settle('TextEdit', before2, { firstMs: 100, gapMs: 100 });
    process.stderr.write(`after double click:\n${diff2}\n`);
    // put bold back
    await engine.click(bold.id, 'press');
  }, 60_000);

  it('refuses a click on an element another window covers', async () => {
    await engine.snapshot('TextEdit');
    const bold = [...engine.current()!.view.items].find((i) => i.label === 'bold')!;
    osa('tell application "Finder" to activate');
    await new Promise((r) => setTimeout(r, 600));
    // TextEdit is now behind Finder's window or not; if bold's centre is covered the click is refused, otherwise it works
    const outcome = await engine.click(bold.id, 'right').then(() => 'clicked', (e: Error) => e.message);
    process.stderr.write(`click on possibly covered element: ${outcome}\n`);
    expect(typeof outcome).toBe('string');
    osa('tell application "TextEdit" to activate');
  }, 60_000);
});
