import { describe, expect, it } from 'vitest';
import type { AxNode, AxSnapshot } from './ax-helper.js';
import { buildView, renderDiff } from './ax-model.js';

let nextId = 1;
const node = (role: string, parent: number, extra: Partial<AxNode> = {}): AxNode => ({
  id: nextId++, parent, role, x: 0, y: 0, width: 100, height: 20, ...extra,
});
const snap = (nodes: AxNode[], over: Partial<AxSnapshot> = {}): AxSnapshot => ({
  ok: true, app: { name: 'Finder', pid: 1 }, window: { title: 'Downloads' }, nodes, truncated: false, timedOut: false, elapsedMs: 5, ...over,
});
const reset = (): void => { nextId = 1; };

/** A window shaped like Finder's: a sidebar outline of rows (cell > text + icon) and a toolbar. */
function finderLike(): AxSnapshot {
  reset();
  const win = node('AXWindow', 0, { label: 'Downloads' });
  const split = node('AXSplitGroup', win.id);
  const area = node('AXScrollArea', split.id, { scroll: 0, off: 7 });
  const outline = node('AXOutline', area.id, { label: 'sidebar' });
  const rows: AxNode[] = [];
  for (const name of ['Recents', 'Desktop', 'Documents']) {
    const row = node('AXRow', outline.id, { sub: 'AXOutlineRow', expanded: false });
    const cell = node('AXCell', row.id, { actions: ['AXOpen'] });
    rows.push(row, cell, node('AXStaticText', cell.id, { value: name }), node('AXImage', cell.id, { label: 'folder' }));
  }
  const bar = node('AXScrollBar', area.id, { value: '0' });
  const toolbar = node('AXToolbar', win.id);
  const back = node('AXButton', toolbar.id, { label: 'Back', actions: ['AXPress'], enabled: false });
  const search = node('AXTextField', toolbar.id, { sub: 'AXSearchField', placeholder: 'Search', focused: true });
  return snap([win, split, area, outline, ...rows, bar, toolbar, back, search]);
}

describe('buildView', () => {
  it('folds a row with its cell, text and icon into one line and keeps its open action', () => {
    const view = buildView(finderLike());
    const lines = view.lines;
    expect(lines).toContain('  [5] row "Recents" collapsed {open}');
    expect(lines.filter((l) => l.includes('Recents'))).toHaveLength(1);
    expect(view.text).not.toMatch(/folder|image|scrollbar/i);
    const row = view.items.find((i) => i.label === 'Recents')!;
    // the cell (id 6) supports AXOpen, the row is what the model sees
    expect(row.actionTargets).toEqual({ AXOpen: 6 });
    expect(view.byId.get(7)).toBe(row); // the folded-in text leads to the row
  });

  it('writes the app and window, then the controls with their state', () => {
    const view = buildView(finderLike());
    expect(view.header).toBe('app: Finder · window: "Downloads"');
    expect(view.lines).toContain('[19] button "Back" disabled');
    expect(view.lines).toContain('[20] search "Search" focused');
  });

  it('shows how much is scrolled out of view and which way', () => {
    // lined up with the rows it is about, not with the window
    expect(buildView(finderLike()).lines).toContain('  … 7 more below (desktop_scroll [3])');
    const mk = (scroll?: number): string[] => {
      reset();
      const win = node('AXWindow', 0);
      const area = node('AXScrollArea', win.id, { off: 3, ...(scroll === undefined ? {} : { scroll }) });
      return buildView(snap([win, area, node('AXButton', area.id, { label: 'Item' })])).lines;
    };
    expect(mk(0.5)).toContain('… 3 more above and below (desktop_scroll [2])');
    expect(mk(1)).toContain('… 3 more above (desktop_scroll [2])');
    expect(mk()).toContain('… 3 more out of view (desktop_scroll [2])');
  });

  it('shows checkboxes, popups, fields and passwords with their value, and never a password', () => {
    reset();
    const win = node('AXWindow', 0);
    const nodes = [
      win,
      node('AXCheckBox', win.id, { label: 'Remember me', value: '1' }),
      node('AXCheckBox', win.id, { label: 'Newsletter', value: '0' }),
      node('AXCheckBox', win.id, { label: 'Mixed', value: '2' }),
      node('AXPopUpButton', win.id, { label: 'Format', value: 'PDF' }),
      node('AXTextField', win.id, { label: 'Name', value: 'Draft', focused: true }),
      node('AXTextField', win.id, { label: 'Password', sub: 'AXSecureTextField', value: 'hunter2' }),
      node('AXTextField', win.id, { label: 'Empty password', sub: 'AXSecureTextField', value: '' }),
      node('AXSlider', win.id, { label: 'Volume', value: '0.5', actions: ['AXIncrement', 'AXDecrement'] }),
    ];
    const text = buildView(snap(nodes)).text;
    expect(text).toContain('checkbox "Remember me" checked');
    expect(text).toContain('checkbox "Newsletter"\n');
    expect(text).toContain('checkbox "Mixed" mixed');
    expect(text).toContain('popup "Format" = "PDF"');
    expect(text).toContain('textfield "Name" = "Draft" focused');
    expect(text).toContain('password "Password" = "••••"');
    expect(text).not.toContain('hunter2');
    expect(text).toContain('slider "Volume" = "0.5" {inc,dec}');
  });

  it('names a control from its placeholder, help or inner text when it has no label', () => {
    reset();
    const win = node('AXWindow', 0);
    const field = node('AXTextField', win.id, { placeholder: 'Search files' });
    const helpOnly = node('AXButton', win.id, { help: 'Share this' });
    const inner = node('AXButton', win.id);
    const text = buildView(snap([win, field, helpOnly, inner, node('AXStaticText', inner.id, { value: 'Open' }), node('AXImage', inner.id, { label: 'arrow' })])).text;
    expect(text).toContain('textfield "Search files"');
    expect(text).toContain('button "Share this"');
    expect(text).toContain('button "Open"');
    expect(text).not.toContain('"arrow"');
  });

  it('keeps a button inside a row as its own line and hides the row text from the page text', () => {
    reset();
    const win = node('AXWindow', 0);
    const row = node('AXRow', win.id);
    const cell = node('AXCell', row.id);
    const nodes = [win, row, cell, node('AXStaticText', cell.id, { value: 'Invoice 42' }), node('AXButton', cell.id, { label: 'Download', actions: ['AXPress'] })];
    const view = buildView(snap(nodes));
    expect(view.lines).toEqual([`[${row.id}] row "Invoice 42"`, `  [${nodes[4]!.id}] button "Download"`]);
  });

  it('lists page text without an id, collapses repeats, and joins the columns of a row', () => {
    reset();
    const win = node('AXWindow', 0);
    const row = node('AXRow', win.id);
    const c1 = node('AXCell', row.id);
    const c2 = node('AXCell', row.id);
    const nodes = [
      win,
      node('AXStaticText', win.id, { value: 'Disk space: 20 GB free' }),
      node('AXStaticText', win.id, { value: 'Disk space: 20 GB free' }),
      node('AXHeading', win.id, { value: 'Storage' }),
      row, c1, node('AXStaticText', c1.id, { value: 'report.pdf' }), c2, node('AXStaticText', c2.id, { value: '2 MB' }),
    ];
    expect(buildView(snap(nodes)).lines).toEqual(['text "Disk space: 20 GB free"', 'heading "Storage"', `[${row.id}] row "report.pdf · 2 MB"`]);
  });

  it('looks through unlabelled groups, indents under lists and toolbars, and stops indenting at three levels', () => {
    reset();
    const win = node('AXWindow', 0);
    const g = node('AXGroup', win.id);
    const tb = node('AXToolbar', g.id, { label: 'Main' });
    const deep = node('AXGroup', tb.id, { label: 'a' });
    const deeper = node('AXGroup', deep.id, { label: 'b' });
    const deepest = node('AXGroup', deeper.id, { label: 'c' });
    const nodes = [win, g, tb, deep, deeper, deepest, node('AXButton', deepest.id, { label: 'Go' })];
    const lines = buildView(snap(nodes)).lines;
    expect(lines[0]).toBe(`[${tb.id}] toolbar "Main"`);
    expect(lines[lines.length - 1]).toBe(`      [${nodes[6]!.id}] button "Go"`);
  });

  it('shows an open menu and its items', () => {
    reset();
    const menu = node('AXMenu', 0);
    const nodes = [menu, node('AXMenuItem', menu.id, { label: 'Copy', actions: ['AXPress'] }), node('AXMenuItem', menu.id, { label: 'Delete', enabled: false })];
    expect(buildView(snap(nodes)).lines).toEqual([`[${menu.id}] menu`, `  [${nodes[1]!.id}] menuitem "Copy"`, `  [${nodes[2]!.id}] menuitem "Delete" disabled`]);
  });

  it('says so when there is no window, the window was only partly read, or nothing was found', () => {
    expect(buildView(snap([], { noWindow: true })).lines).toContain('note: this app has no open window');
    reset();
    const win = node('AXWindow', 0);
    expect(buildView(snap([win], { truncated: true })).lines.join('\n')).toContain('only part of it was read');
    expect(buildView(snap([win])).lines).toContain('(no interactive elements found)');
    expect(buildView(snap([win], { timedOut: true })).truncated).toBe(true);
  });

  it('cleans labels: control characters, quotes, length', () => {
    reset();
    const win = node('AXWindow', 0);
    const view = buildView(snap([win, node('AXButton', win.id, { label: `Say "hi"\n\tnow ${'x'.repeat(200)}` })]));
    const line = view.lines[0]!;
    expect(line).toContain('\\"hi\\" now ');
    expect(line).not.toMatch(/[\n\t]/);
    expect(line.length).toBeLessThan(120);
    expect(line).toContain('…');
  });

  it('survives a tree whose parent links loop back or repeat, and shows each element once', () => {
    reset();
    const a = node('AXWindow', 0);
    const b = node('AXGroup', a.id, { label: 'Panel' });
    const loopA: AxNode = { ...a, parent: b.id }; // the window claims its own child as parent
    const dup = { ...b }; // the same element reported twice
    const btn = node('AXButton', b.id, { label: 'Once' });
    const self: AxNode = { id: 500, parent: 500, role: 'AXButton', label: 'Self', x: 0, y: 0, width: 10, height: 10 };
    const view = buildView(snap([loopA, b, dup, btn, self]));
    expect(view.lines.filter((l) => l.includes('Once'))).toHaveLength(1);
    expect(view.lines.filter((l) => l.includes('Self'))).toHaveLength(1);
    expect(view.lines.filter((l) => l.includes('Panel'))).toHaveLength(1);
  });

  it('treats a node whose parent was not reported as a root', () => {
    reset();
    const orphan = node('AXButton', 999, { label: 'Lonely' });
    expect(buildView(snap([orphan])).lines).toEqual([`[${orphan.id}] button "Lonely"`]);
  });

  it('caps long lists, dropping plain text before controls, and says how many were hidden', () => {
    reset();
    const win = node('AXWindow', 0);
    const nodes = [win];
    for (let i = 0; i < 30; i += 1) nodes.push(node('AXStaticText', win.id, { value: `line ${i}` }));
    for (let i = 0; i < 10; i += 1) nodes.push(node('AXButton', win.id, { label: `B${i}` }));
    const view = buildView(snap(nodes), { max: 15 });
    expect(view.lines.filter((l) => l.includes('button')).length).toBe(10);
    expect(view.lines[view.lines.length - 1]).toBe('… 25 more elements hidden; pass filter to narrow');
    expect(view.hidden).toBe(25);
  });

  it('a filter shows only matches and says when nothing matches', () => {
    const view = buildView(finderLike(), { filter: 'doc' });
    expect(view.lines.filter((l) => !l.startsWith('…'))).toEqual(['  [13] row "Documents" collapsed {open}']);
    expect(buildView(finderLike(), { filter: 'zzz' }).lines).toEqual(['(nothing matches "zzz")']);
  });
});

describe('fingerprint and diff', () => {
  const mk = (label: string, value?: string): AxSnapshot => {
    reset();
    const win = node('AXWindow', 0);
    return snap([win, node('AXButton', win.id, { label: 'Save' }), node('AXTextField', win.id, { label, ...(value ? { value } : {}) }), node('AXButton', win.id, { label: 'Cancel' })]);
  };

  it('is the same for the same window and changes with anything visible', () => {
    expect(buildView(mk('Name')).fingerprint).toBe(buildView(mk('Name')).fingerprint);
    expect(buildView(mk('Name', 'a')).fingerprint).not.toBe(buildView(mk('Name', 'b')).fingerprint);
  });

  it('reports no change, a changed line, a new line and a removed one', () => {
    const base = buildView(mk('Name'));
    expect(renderDiff(base, buildView(mk('Name')))).toBe('app: Finder · window: "Downloads" (same window)\nno visible change');
    const typed = renderDiff(base, buildView(mk('Name', 'Ann')));
    expect(typed).toContain('~ [3] textfield "Name" = "Ann"');
    expect(typed).toContain('(2 unchanged)');
    reset();
    const win = node('AXWindow', 0);
    const withDialog = snap([win, node('AXButton', win.id, { label: 'Save' }), node('AXTextField', win.id, { label: 'Name' }), node('AXButton', win.id, { label: 'Cancel' }), node('AXButton', win.id, { label: 'Retry' })]);
    expect(renderDiff(base, buildView(withDialog))).toContain('+ [5] button "Retry"');
    reset();
    const w2 = node('AXWindow', 0);
    const gone = snap([w2, node('AXButton', w2.id, { label: 'Save' }), node('AXTextField', w2.id, { label: 'Name' }), node('AXButton', w2.id, { label: 'Cancel' })]);
    reset();
    const w3 = node('AXWindow', 0);
    const fewer = snap([w3, node('AXButton', w3.id, { label: 'Save' }), node('AXTextField', w3.id, { label: 'Name' })]);
    expect(renderDiff(buildView(gone), buildView(fewer))).toContain('- [4] button "Cancel"');
  });

  it('shows the whole window when it is a different window or most of it changed', () => {
    const base = buildView(mk('Name'));
    const other = buildView({ ...mk('Name'), window: { title: 'Other' } });
    expect(renderDiff(base, other)).toBe(other.text);
    reset();
    const win = node('AXWindow', 0);
    const rewritten = buildView(snap([win, node('AXButton', win.id, { label: 'One' }), node('AXButton', win.id, { label: 'Two' }), node('AXButton', win.id, { label: 'Three' })]));
    expect(renderDiff(base, rewritten)).toBe(rewritten.text);
    expect(renderDiff(null, base)).toBe(base.text);
  });
});
