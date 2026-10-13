# HUD Browser Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the HUD's browser tools work on the pages real people use (shadow DOM, same-site iframes, links that open tabs, keyboard-driven widgets) and cut model turns by letting `browser_do` address elements by their visible label, without changing how any existing call behaves.

**Architecture:** All changes are in `packages/daemon/src/browser/`, `browser-snapshot.ts`, `computer/`, plus prompt and skill text. The page-side snapshot script learns to walk open shadow roots and same-origin frames (reporting unreadable frames as a count). Page-side action scripts become frame-aware, and gain `hover`, real `Tab` focus movement and a "opens in a new tab" hint. `FastBrowserEngine.do` resolves `target` labels against the last shown page (refusing ambiguous or missing labels before running anything), accepts up to 30 steps, and surfaces the new hints as `note:` lines. A privacy-safe per-call log gives the next speed plan real numbers.

**Tech Stack:** TypeScript, vitest (`npx vitest run <path>` from the repo root), jsdom 26 for page-script tests, pnpm/npm workspace.

**Spec:** None written. Design basis: `docs/superpowers/specs/2026-10-03-fast-browser-engine-design.md` (non-goals there named iframes and shadow DOM; this plan lifts exactly those two) and the improvement review in this session. The earlier `docs/superpowers/plans/2026-10-04-hud-speed.md` is already implemented in the tree (previous-task digest, SKILL.md rule, blocked-osascript sentence, `NODE_NO_WARNINGS`); it is not part of this plan.

## Declined on purpose (and why)

- **Skipping the 80 ms settle after pure input ops.** Measured in code: the whole post-action wait is 80-230 ms against a 3-7 s model turn. It is not worth the risk of missing a validation message that appears right after typing.
- **Drag and file upload.** Synthetic drag events are unreliable across sites; upload needs file-system access to user files, a security decision that needs its own design.
- **Auto-accepting `alert`/`confirm` dialogs or hooking `window.open`.** Auto-accepting a "Delete?" confirm is unsafe, and wrapping page natives is what bot-detection scripts look for. The new-tab hint uses the link's `target="_blank"` attribute instead, with no page tampering.
- **Continue-on-error batches.** Stopping at the first failure is the safe behaviour for people's real accounts.
- **A HUD toast when fast mode is off.** It needs a native overlay change and a UX decision. `rh browser doctor` and the existing `note:` already cover it; offered as a follow-up.

## Global Constraints

- Do not change the element line format `[id] role "label" = "value" [checked] options: a | b | …(+N)` or the header/delta lines. `packages/daemon/src/fast-lane/pilot/parse.ts` parses them with fixed regexes. Extra information goes in separate `note: …` lines (the parser keeps unknown lines as notes).
- `DOM_SNAPSHOT_SCRIPT` is a TypeScript template literal: no backticks, no `${`, and no backslashes in anything added to it. Keep these exact substrings, which tests and the fake transport match on: `window.__rhFast = window.__jevFast` (inside `const cache = (window.__jevFast = window.__rhFast = …`), `checkVisibility`, and the line `cache.name = name; cache.role = role; cache.visible = visible;`.
- Never wrap or replace page globals (`window.open`, `alert`, `confirm`, `history`). Page-visible side effects stay what they are today: the `__rh*` window properties and the `beforeunload`/`pagehide` listeners.
- Action scripts keep the identity and label guards: an action on a node that left the page or changed label still fails with `stale` / `changed`.
- Password values never leave the page: snapshot masks them (`••••••••`), extract skips them, in shadow roots and frames too.
- Legacy path (`LegacyBrowserPort`) behaviour is unchanged except that it rejects `target` steps with a clear message.
- `SLIM_COMPUTER_PROMPT` may only mention tool names that `buildComputerTools` produces (test `mentions exactly the tool names`). Do not write `browser_<word>` or `desktop_<word>` for anything that is not a tool. Keep the rule numbering and the phrases existing prompt tests assert.
- `.agents/skills/remote-hands-operator/SKILL.md` must stay byte-identical to `REMOTE_HANDS_OPERATOR_SKILL_MD` in `packages/cli/src/system/operator-skill.ts` (test `stays identical to the repo skill file`).
- Commit messages use repo style (`feat(browser): …`, `fix(browser): …`, `docs: …`), end with the attribution line from the session, and never use `git add -A` (the working tree has unrelated edits: `.gitignore`, `.gitattributes`, `docs/superpowers/plans/2026-10-04-hud-speed.md`; leave them alone).
- Baseline: `npx vitest run packages/daemon` has exactly one pre-existing failure, `src/screen-capture.test.ts > DefaultFrameSource > handles capture without throwing when no sources available` (timeout, unrelated). Any other failure is ours.

## Review Focus

- A cross-origin or sandboxed iframe on the page: snapshot must not throw, same-site content around it is still listed, and the unreadable frame is counted and reported (small or hidden frames such as ad pixels are not).
- A page that embeds itself or nests shadow roots/frames deeper than 3 levels, or has a huge DOM: work stays bounded (depth cap 3, scan cap 100000 elements) and the snapshot still returns.
- `target` that matches nothing, matches several elements, or matches a different kind of element than the op needs (a button named "Email" when typing): fail before any step runs, listing candidates, never click a guess.
- Closed shadow roots and `display:none` frames: ignored silently, no error, not counted as unreadable.
- Legacy fallback receiving `target` or `hover`: clear message that names the fix (use `index`), never silent misbehaviour.
- Password fields inside a shadow root or same-site frame: masked in snapshot, absent in extract.
- A synthetic `Tab` whose `keydown` the page cancels must not move focus; `Tab` with no focusable controls must not throw.

---

## File Structure

- Modify `packages/daemon/src/browser-snapshot.ts`: composed-tree helpers, `gather` walker, frame/shadow aware actions and text, `cache.deepAll`, `frames_blocked`.
- Modify `packages/daemon/src/browser/page-scripts.ts`: frame-aware `type`/`press`, extract recursion, `hover`, `Tab`, `opened`/`focused` result fields.
- Modify `packages/daemon/src/browser/render.ts`: `blockedFrames` in `PageState`, note line in `renderFull`.
- Create `packages/daemon/src/browser/targets.ts` (+ `targets.test.ts`): label to element resolution.
- Modify `packages/daemon/src/browser/port.ts`, `engine.ts`, `legacy-port.ts`: `DoStep` gains `target` and `hover`; limit 30; notes.
- Modify `packages/daemon/src/computer/tools.ts`: schema and descriptions.
- Modify `packages/daemon/src/computer/prompt.ts`, `packages/cli/src/system/operator-skill.ts`, `.agents/skills/remote-hands-operator/SKILL.md`, `docs/development.md`: text.
- Create `packages/daemon/src/computer/call-log.ts` (+ test); modify `computer/mcp-server.ts`.
- Tests: `browser/page-scripts.test.ts` (jsdom helper `makePage` lives there), `browser/render.test.ts`, `browser/engine.test.ts`, `browser/legacy-port.test.ts`, `computer/tools.test.ts`, `computer/prompt.test.ts`, `computer/mcp-server.test.ts`.

## Execution protocol (applies to every stage)

Stages: **A** = Tasks 1-3 (page coverage), **B** = Tasks 4-6 (new ops and engine), **C** = Tasks 7-8 (text and call log), **D** = Task 9 (whole-branch check).

At the end of each stage:

1. `git log --oneline main..HEAD` is the commit list. Give it to Codex with the prompt in Task 9's "Codex review prompt" (stage name filled in). Codex writes `docs/superpowers/reviews/<stage>-codex-review.md` and changes no other file.
2. Read the review. Verify each finding against the code before acting (do not apply blindly). Fix real ones with a failing test first. Record `fixed`, `rejected: <reason>` or `deferred: <reason>` under each finding in the review file.
3. Ask Codex to re-review only the fix commits and append a "Round 2" section. Repeat until Codex reports no open P0/P1/P2 findings, at most 3 rounds. Anything still open is reported to the user, not hidden.
4. Commit the review file: `docs: codex review for stage <X>`.

---

### Task 1: Snapshot reads open shadow roots and same-origin frames

**Files:**
- Modify: `packages/daemon/src/browser-snapshot.ts` (the `DOM_SNAPSHOT_SCRIPT` string)
- Test: `packages/daemon/src/browser/page-scripts.test.ts` (new `describe` at the end)

**Interfaces:**
- Produces: `window.__rhFast.deepAll(selector: string): Element[]` (live, composed-tree query used by Task 4's Tab handling); snapshot result gains `frames_blocked?: number` (only present when greater than 0); every action's `rect` is in top-window viewport coordinates.
- Consumes: nothing.

- [ ] **Step 1: Write the failing tests**

Append to `packages/daemon/src/browser/page-scripts.test.ts`:

```ts
function nodeOf(p: Page, el: unknown): number {
  return p.win.__rhFast.ids.get(el);
}

function addFrame(p: Page, html: string, rect = { left: 10, top: 20, width: 300, height: 200 }): any {
  const frame = p.doc.createElement('iframe');
  p.doc.body.appendChild(frame);
  frame.contentDocument.body.innerHTML = html;
  frame.getBoundingClientRect = () => ({
    x: rect.left, y: rect.top, left: rect.left, top: rect.top, width: rect.width, height: rect.height,
    right: rect.left + rect.width, bottom: rect.top + rect.height,
  });
  return frame;
}

describe('snapshot across shadow roots and frames', () => {
  it('lists controls and text inside an open shadow root and keeps them actionable', () => {
    const p = makePage('<div id="host"></div><button id="top">Top</button>');
    const root = p.doc.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<p>Secure checkout</p><input id="card" type="text" aria-label="Card number"><button id="pay">Pay now</button>';
    let clicks = 0;
    root.getElementById('pay').addEventListener('click', () => { clicks += 1; });
    const snap = p.snapshot();
    const labels = snap.actions.map((a: any) => a.label);
    expect(labels).toEqual(expect.arrayContaining(['Top', 'Pay now', 'Card number']));
    expect(snap.text).toContain('Secure checkout');
    expect(p.run({ op: 'click', node: nodeOf(p, root.getElementById('pay')), label: 'Pay now' })).toMatchObject({ ok: true });
    expect(clicks).toBe(1);
  });

  it('lists controls inside a same-origin iframe, offsets their rect, and acts on them', () => {
    const p = makePage('<button id="top">Top</button>');
    const frame = addFrame(p, '<input id="q" type="text" aria-label="Survey answer"><button id="next">Next question</button>');
    let clicks = 0;
    frame.contentDocument.getElementById('next').addEventListener('click', () => { clicks += 1; });
    const snap = p.snapshot();
    const next = snap.actions.find((a: any) => a.label === 'Next question');
    expect(next).toBeDefined();
    expect(next.rect).toMatchObject({ x: 10, y: 20 });
    expect(p.run({ op: 'click', node: next.node, label: 'Next question' })).toMatchObject({ ok: true });
    expect(clicks).toBe(1);
    const q = snap.actions.find((a: any) => a.label === 'Survey answer');
    expect(p.run({ op: 'type', node: q.node, label: 'Survey answer', text: 'Somewhat confident' })).toMatchObject({ ok: true });
    expect(frame.contentDocument.getElementById('q').value).toBe('Somewhat confident');
  });

  it('masks password values inside a shadow root and a frame', () => {
    const p = makePage('<div id="host"></div>');
    p.doc.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<input id="pw1" type="password" aria-label="Shadow password" value="hunter2">';
    addFrame(p, '<input type="password" aria-label="Frame password" value="swordfish">');
    // The engine reads the light snapshot (full mode also carries guards with raw values for the legacy driver).
    const json = JSON.stringify(p.evalJson(buildSnapshotCall()));
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('swordfish');
    expect(json).toContain('••••••••');
  });

  it('counts a visible frame it cannot read and ignores small or hidden ones', () => {
    const p = makePage('<button id="top">Top</button>');
    const blocked = addFrame(p, '', { left: 0, top: 0, width: 400, height: 300 });
    Object.defineProperty(blocked, 'contentDocument', { get: () => null });
    const pixel = addFrame(p, '', { left: 0, top: 0, width: 1, height: 1 });
    Object.defineProperty(pixel, 'contentDocument', { get: () => null });
    const snap = p.snapshot();
    expect(snap.frames_blocked).toBe(1);
    expect(snap.actions.map((a: any) => a.label)).toContain('Top');
  });

  it('does not report frames_blocked when every frame is readable', () => {
    const p = makePage('<button>Top</button>');
    addFrame(p, '<button>Inside</button>');
    expect('frames_blocked' in p.snapshot()).toBe(false);
  });

  it('ignores closed shadow roots without error', () => {
    const p = makePage('<div id="host"></div><button>Visible</button>');
    p.doc.getElementById('host').attachShadow({ mode: 'closed' }).innerHTML = '<button>Secret</button>';
    const labels = p.snapshot().actions.map((a: any) => a.label);
    expect(labels).toContain('Visible');
    expect(labels).not.toContain('Secret');
  });

  it('stops descending after 3 nested shadow levels', () => {
    const p = makePage('<div id="h0"></div>');
    let host = p.doc.getElementById('h0');
    for (let level = 1; level <= 5; level += 1) {
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<button>L${level}</button><div class="next"></div>`;
      host = root.querySelector('.next');
    }
    const labels = p.snapshot().actions.map((a: any) => a.label);
    expect(labels).toEqual(expect.arrayContaining(['L1', 'L2', 'L3']));
    expect(labels).not.toContain('L4');
    expect(labels).not.toContain('L5');
  });

  it('exposes deepAll for composed-tree queries', () => {
    const p = makePage('<div id="host"></div><button>Top</button>');
    p.doc.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button>Inner</button>';
    p.snapshot();
    const found = p.win.__rhFast.deepAll('button').map((b: any) => b.textContent);
    expect(found).toEqual(expect.arrayContaining(['Top', 'Inner']));
  });
});
```

If jsdom cannot give a freshly appended `<iframe>` a `contentDocument.body` (the first frame test fails with a TypeError in `addFrame`, not in product code), change `addFrame` to create the frame with `srcdoc` and `await` its load; adapt the test helper, never the product code.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/daemon/src/browser/page-scripts.test.ts -t "across shadow roots"`
Expected: FAIL (`Pay now` missing from labels; `deepAll` is not a function).

- [ ] **Step 3: Implement in `DOM_SNAPSHOT_SCRIPT`**

In `packages/daemon/src/browser-snapshot.ts`:

(a) Replace the line `const safe = (e) => !['file', 'hidden'].includes(e.type);` and the `visible` definition that follows it with:

```js
  const safe = (e) => !['file', 'hidden'].includes(e.type);
  const MAX_NEST = 3;
  const MAX_SCAN = 100000;
  const hostOf = (e) => { const r = e.getRootNode && e.getRootNode(); return r && r.host ? r.host : null; };
  const frameOf = (e) => {
    const view = e.ownerDocument && e.ownerDocument.defaultView;
    try { return view && view !== window ? view.frameElement : null; } catch (err) { return null; }
  };
  const closestDeep = (e, sel) => {
    for (let n = e; n; n = n.parentElement || hostOf(n) || frameOf(n)) {
      if (typeof n.matches === 'function' && n.matches(sel)) return n;
    }
    return null;
  };
  const byId = (e, id) => {
    const r = e.getRootNode && e.getRootNode();
    const scope = r && typeof r.getElementById === 'function' ? r : e.ownerDocument;
    return scope.getElementById(id);
  };
  const visible = (e) => !closestDeep(e, '[aria-hidden="true"],[inert]') &&
    (typeof e.checkVisibility === 'function' ? e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true);
```

The `checkVisibility` argument is unchanged from today; only the ancestor check changed from `closest` to `closestDeep`.

(b) In `name`, replace `.map((id) => name(document.getElementById(id), seen))` with `.map((id) => name(byId(e, id), seen))`.

(c) After the `cache.pageKey` / `cache.guard` definitions and before `const actions = [];`, add the walker and the `deepAll` export:

```js
  let blocked = 0;
  const textRoots = [];
  const gather = (root, dx, dy, depth, sel, found, track) => {
    for (const e of root.querySelectorAll(sel)) found.push({ e, dx, dy });
    if (track) textRoots.push({ root: root.body || root, dx, dy });
    if (depth >= MAX_NEST) return;
    const all = root.querySelectorAll('*');
    const count = Math.min(all.length, MAX_SCAN);
    for (let i = 0; i < count; i++) {
      const host = all[i];
      if (host.shadowRoot) { gather(host.shadowRoot, dx, dy, depth + 1, sel, found, track); continue; }
      if (host.tagName !== 'IFRAME' && host.tagName !== 'FRAME') continue;
      let doc = null;
      try { doc = host.contentDocument; } catch (err) { doc = null; }
      const r = host.getBoundingClientRect();
      if (doc && doc.body) {
        if (visible(host)) gather(doc, dx + r.left + (host.clientLeft || 0), dy + r.top + (host.clientTop || 0), depth + 1, sel, found, track);
      } else if (!doc && track && r.width >= 50 && r.height >= 50 && visible(host)) {
        blocked++;
      }
    }
  };
  cache.deepAll = (sel) => { const list = []; gather(document, 0, 0, 0, sel, list, false); return list.map((f) => f.e); };
```

(d) Replace the head of the actions loop. The old text

```js
  const actions = [];
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r = typeof e.getBoundingClientRect === 'function' ? e.getBoundingClientRect() : { x: 0, y: 0, width: 10, height: 10 };
    const x = r.x + (r.width || 10) / 2, y = r.y + (r.height || 10) / 2, rname = role(e);
    const isNodeEnv = typeof window.CSS === 'undefined';
    if (!rname || (!isNodeEnv && (r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight))) continue;
```

becomes

```js
  const actions = [];
  const found = [];
  gather(document, 0, 0, 0, selector, found, true);
  for (const { e, dx, dy } of found) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || closestDeep(e, '[aria-disabled="true"]')) continue;
    const r = typeof e.getBoundingClientRect === 'function' ? e.getBoundingClientRect() : { x: 0, y: 0, width: 10, height: 10 };
    const win = (e.ownerDocument && e.ownerDocument.defaultView) || window;
    const lx = r.x + (r.width || 10) / 2, ly = r.y + (r.height || 10) / 2;
    const x = lx + dx, y = ly + dy, rname = role(e);
    const isNodeEnv = typeof window.CSS === 'undefined';
    const outside = lx < 0 || ly < 0 || lx >= win.innerWidth || ly >= win.innerHeight || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight;
    if (!rname || (!isNodeEnv && (r.width <= 0 || r.height <= 0 || outside))) continue;
```

and in the `base` object change `rect: { x: r.x, y: r.y, w: r.width, h: r.height }` to `rect: { x: r.x + dx, y: r.y + dy, w: r.width, h: r.height }`.

(e) Replace the text-collection block (from `const words = [];` through `const text = words.join(...)`) with:

```js
  const words = [];
  let length = 0;
  for (const tr of textRoots) {
    if (length >= 6000) break;
    const tdoc = tr.root.ownerDocument || tr.root;
    const twin = tdoc.defaultView || window;
    const walker = tdoc.createTreeWalker(tr.root, 4);
    const range = tdoc.createRange();
    let node;
    while ((node = walker.nextNode()) && length < 6000) {
      const value = node.textContent.trim();
      const parent = node.parentElement;
      if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
      range.selectNodeContents(node);
      const r = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : { width: 10, height: 10, bottom: 10, top: 1, right: 10, left: 1 };
      const inOwn = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < twin.innerHeight && r.right > 0 && r.left < twin.innerWidth;
      const inTop = r.bottom + tr.dy > 0 && r.top + tr.dy < innerHeight && r.right + tr.dx > 0 && r.left + tr.dx < innerWidth;
      if (inOwn && inTop) {
        words.push(value);
        length += value.length;
      }
    }
  }
  const text = words.join('\\n').slice(0, 6000);
```

(the `'\\n'` is already how the source spells a newline inside the template literal; keep that spelling.)

(f) After `const out = { url: location.href, … omitted_actions };` add `if (blocked > 0) out.frames_blocked = blocked;` before the `if (light) { delete out.marker; delete out.guards; }` line.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/daemon/src/browser/page-scripts.test.ts packages/daemon/src/browser-snapshot.test.ts packages/daemon/src/browser-driver.test.ts packages/daemon/src/browser/engine.test.ts`
Expected: PASS (new tests and every existing test).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/browser-snapshot.ts packages/daemon/src/browser/page-scripts.test.ts
git commit -m "feat(browser): snapshot reads open shadow roots and same-origin frames"
```

---

### Task 2: Actions and extract work inside shadow roots and frames

**Files:**
- Modify: `packages/daemon/src/browser/page-scripts.ts` (`PRELUDE`, `TYPE`, `PRESS`, `buildExtractScript`)
- Test: `packages/daemon/src/browser/page-scripts.test.ts`

**Interfaces:**
- Consumes: Task 1's frame/shadow aware snapshot (nodes in `__rhFast.nodes`).
- Produces: `deepActive()` inside action scripts (used by Task 4); `buildExtractScript` reads shadow roots and same-origin frames (depth 3).

- [ ] **Step 1: Write the failing tests**

Append to `page-scripts.test.ts`:

```ts
describe('actions and extract inside shadow roots and frames', () => {
  it('types into a contenteditable inside a frame using the frame document', () => {
    const p = makePage('', { contentEditable: true });
    const frame = addFrame(p, '<div id="ed" contenteditable="true" role="textbox" aria-label="Reply"></div>');
    const idoc = frame.contentDocument;
    const calls: Array<[string, unknown]> = [];
    idoc.execCommand = (cmd: string, _ui: boolean, val: unknown) => { calls.push([cmd, val]); return true; };
    Object.defineProperty(idoc.defaultView.HTMLElement.prototype, 'innerText', { configurable: true, get(this: any) { return this.textContent; } });
    Object.defineProperty(idoc.defaultView.HTMLElement.prototype, 'isContentEditable', {
      configurable: true,
      get(this: any) { const v = this.getAttribute('contenteditable'); return v !== null && v !== 'false'; },
    });
    const snap = p.snapshot();
    const reply = snap.actions.find((a: any) => a.label === 'Reply');
    expect(reply).toBeDefined();
    expect(p.run({ op: 'type', node: reply.node, label: 'Reply', text: 'Thanks!' })).toMatchObject({ ok: true });
    expect(calls).toEqual([['insertText', 'Thanks!']]);
  });

  it('press Enter goes to the focused control inside a shadow root', () => {
    const p = makePage('<div id="host"></div>');
    const root = p.doc.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<input id="in" type="text" aria-label="Search">';
    const input = root.getElementById('in');
    let seen = 0;
    input.addEventListener('keydown', (e: any) => { if (e.key === 'Enter') seen += 1; });
    input.focus();
    expect(p.run({ op: 'press', key: 'Enter' })).toMatchObject({ ok: true });
    expect(seen).toBe(1);
  });

  it('press goes to the focused control inside a same-origin frame', () => {
    const p = makePage('');
    const frame = addFrame(p, '<input id="in" type="text" aria-label="Answer">');
    const input = frame.contentDocument.getElementById('in');
    let seen = 0;
    input.addEventListener('keydown', () => { seen += 1; });
    input.focus();
    frame.focus();
    expect(p.run({ op: 'press', key: 'Escape' })).toMatchObject({ ok: true });
    expect(seen).toBe(1);
  });

  it('extract includes shadow-root and same-origin frame text and still skips passwords', () => {
    const p = makePage('<main><p>Top text</p><div id="host"></div></main>');
    p.doc.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<p>Shadow text</p><input type="password" value="hunter2">';
    addFrame(p, '<p>Frame text</p><input type="password" value="swordfish">');
    const out = p.evalJson(buildExtractScript(2000));
    expect(out.text).toContain('Top text');
    expect(out.text).toContain('Shadow text');
    expect(out.text).toContain('Frame text');
    expect(out.text).not.toContain('hunter2');
    expect(out.text).not.toContain('swordfish');
  });

  it('extract stops at 3 nested frame levels so a page embedding itself cannot loop', () => {
    const p = makePage('<p>Level0</p>');
    let doc = p.doc;
    for (let level = 1; level <= 5; level += 1) {
      const f = doc.createElement('iframe');
      doc.body.appendChild(f);
      f.contentDocument.body.innerHTML = `<p>Level${level}</p>`;
      doc = f.contentDocument;
    }
    const text = p.evalJson(buildExtractScript(2000)).text as string;
    expect(text).toContain('Level3');
    expect(text).not.toContain('Level4');
  });
});
```

(In the second test, `frame.focus()` is needed because jsdom's `document.activeElement` is the iframe element when focus is inside it; if jsdom does not move `activeElement` to the iframe, assign it by focusing the frame element before the input and adapt the helper, not the product code.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/daemon/src/browser/page-scripts.test.ts -t "inside shadow roots and frames"`
Expected: FAIL (editor text goes to the wrong document; press lands on the host/iframe; extract lacks shadow/frame text).

- [ ] **Step 3: Implement**

In `page-scripts.ts`:

(a) Add to the end of `PRELUDE` (before the closing backtick), after `NON_TYPABLE`:

```js
  const deepActive = () => {
    let a = document.activeElement || document.body;
    for (let i = 0; i < 8 && a; i++) {
      let next = null;
      if (a.shadowRoot && a.shadowRoot.activeElement) next = a.shadowRoot.activeElement;
      else if (a.tagName === 'IFRAME' || a.tagName === 'FRAME') {
        try { const d = a.contentDocument; if (d && d.activeElement) next = d.activeElement; } catch (e) { next = null; }
      }
      if (!next || next === a) break;
      a = next;
    }
    return a;
  };
```

(b) In `TYPE`, replace the contenteditable branch's use of `document` with the element's own document. The block

```js
    let inserted = false;
    if (typeof document.execCommand === 'function') {
      try {
        const sel = window.getSelection && window.getSelection();
        if (sel && document.createRange) {
          const range = document.createRange();
```

becomes

```js
    const ownDoc = el.ownerDocument || document;
    const ownView = ownDoc.defaultView || window;
    let inserted = false;
    if (typeof ownDoc.execCommand === 'function') {
      try {
        const sel = ownView.getSelection && ownView.getSelection();
        if (sel && ownDoc.createRange) {
          const range = ownDoc.createRange();
```

and `inserted = document.execCommand('insertText', false, text) === true;` becomes `inserted = ownDoc.execCommand('insertText', false, text) === true;`.

(c) In `PRESS`, replace `const target = document.activeElement || document.body;` with `const target = deepActive();`.

(d) In `buildExtractScript`, replace

```js
  const walk = (n) => {
    if (truncated) return;
```

with `const walk = (n, depth) => {` plus `if (truncated) return;`, and replace the final loop `for (const c of n.childNodes) walk(c);` and the root call so recursion carries depth:

```js
    if (n.shadowRoot && depth < 3) for (const c of n.shadowRoot.childNodes) walk(c, depth + 1);
    if ((n.tagName === 'IFRAME' || n.tagName === 'FRAME') && depth < 3) {
      let d = null;
      try { d = n.contentDocument; } catch (e) { d = null; }
      if (d && d.body) walk(d.body, depth + 1);
    }
    for (const c of n.childNodes) walk(c, depth);
```

Inside `walk`, the text-node branch `add(n.textContent || '')` and every other `walk(c)` call become `walk(c, depth)`; the initial call becomes `if (root) walk(root, 0);`. Keep the doubled backslash spelling already used in this template literal.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/daemon/src/browser`
Expected: PASS (all browser tests, including the existing contenteditable and extract tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/browser/page-scripts.ts packages/daemon/src/browser/page-scripts.test.ts
git commit -m "feat(browser): typing, key presses and text extraction work inside shadow roots and frames"
```

---

### Task 3: Tell the agent when frames from other sites cannot be read

**Files:**
- Modify: `packages/daemon/src/browser/render.ts` (`PageState`, `normalizeSnapshot`, `renderFull`)
- Test: `packages/daemon/src/browser/render.test.ts`

**Interfaces:**
- Consumes: snapshot field `frames_blocked` (Task 1).
- Produces: `PageState.blockedFrames?: number`; `renderFull` appends one line `note: N embedded frame(s) from another website cannot be read here; use desktop_snapshot for that part`.

- [ ] **Step 1: Write the failing tests**

Add to `render.test.ts` (match its existing import style; it imports from `./render.js`):

```ts
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
    expect(one.at(-1)).toBe('note: 1 embedded frame from another website cannot be read here; use desktop_snapshot for that part');
    const two = renderFull(normalizeSnapshot({ ...base, frames_blocked: 2 }), { text: false }).split('\n');
    expect(two.at(-1)).toBe('note: 2 embedded frames from another website cannot be read here; use desktop_snapshot for that part');
    expect(renderFull(normalizeSnapshot(base), { text: false })).not.toContain('embedded frame');
  });

  it('keeps the element lines in the exact existing format', () => {
    const lines = renderFull(normalizeSnapshot({ ...base, frames_blocked: 1 }), { text: false }).split('\n');
    expect(lines[1]).toBe('[1] button "Go"');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/daemon/src/browser/render.test.ts -t "blocked frames"`
Expected: FAIL (`blockedFrames` undefined / no note line).

- [ ] **Step 3: Implement**

In `render.ts`: add `/** Visible frames from another site that the page script cannot read. */ blockedFrames?: number;` to `PageState`. In `normalizeSnapshot`, after the `omitted_actions` line add:

```ts
  if (typeof obj.frames_blocked === 'number' && Number.isFinite(obj.frames_blocked) && obj.frames_blocked > 0) {
    state.blockedFrames = Math.floor(obj.frames_blocked);
  }
```

In `renderFull`, after the `state.omitted` block and before `return lines.join('\n')`:

```ts
  if (state.blockedFrames) {
    const n = state.blockedFrames;
    lines.push(
      `note: ${n} embedded ${n === 1 ? 'frame' : 'frames'} from another website cannot be read here; use desktop_snapshot for that part`,
    );
  }
```

- [ ] **Step 4: Run to verify pass, plus the pilot parser**

Run: `npx vitest run packages/daemon/src/browser packages/daemon/src/fast-lane`
Expected: PASS. Add one assertion to `packages/daemon/src/fast-lane/pilot/parse.test.ts`: `parseRendered` of a rendered state that ends with the `note: 1 embedded frame …` line keeps the elements and returns that line in `notes`.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/browser/render.ts packages/daemon/src/browser/render.test.ts packages/daemon/src/fast-lane/pilot/parse.test.ts
git commit -m "feat(browser): note when embedded frames from other sites cannot be read"
```

**Stage A ends here: run the Execution protocol (Codex review of Tasks 1-3).**

---

### Task 4: Page ops: hover, real Tab focus movement, new-tab hint

**Files:**
- Modify: `packages/daemon/src/browser/page-scripts.ts` (`PageOp`, `PageOpResult`, `PRELUDE`, `CLICK`, new `HOVER`, `PRESS`, `BODIES`)
- Test: `packages/daemon/src/browser/page-scripts.test.ts`

**Interfaces:**
- Consumes: `window.__rhFast.deepAll` and `visible` (Task 1), `deepActive` (Task 2).
- Produces: `PageOp` gains `{ op: 'hover'; node: number; label: string }`; `PageOpResult` ok variant gains `opened?: boolean` (click on a `target="_blank"` link; omitted otherwise) and `focused?: string` (label of the control a Tab moved to; omitted when focus did not move). `press` accepts `Tab` and `Shift+Tab` in any letter case.

- [ ] **Step 1: Write the failing tests**

Append to `page-scripts.test.ts`:

```ts
describe('buildActionScript: hover', () => {
  it('fires over/enter/move on the element and enter on its ancestors, outermost first', () => {
    const p = makePage('<nav id="menu"><a id="item" href="#x">Products</a></nav>');
    const seen: string[] = [];
    for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
      p.doc.getElementById('menu').addEventListener(type, () => seen.push(`menu:${type}`));
      p.doc.getElementById('item').addEventListener(type, () => seen.push(`item:${type}`));
    }
    p.snapshot();
    expect(p.run({ op: 'hover', node: p.node('#item'), label: 'Products' })).toMatchObject({ ok: true });
    expect(seen).toEqual(expect.arrayContaining(['menu:mouseenter', 'item:mouseenter', 'item:mouseover', 'menu:mouseover', 'item:mousemove']));
    expect(seen.indexOf('menu:mouseenter')).toBeLessThan(seen.indexOf('item:mouseenter'));
  });

  it('keeps the label and disabled guards', () => {
    const p = makePage('<button id="b">Save</button><button id="d" disabled>Off</button>');
    p.snapshot();
    expect(p.run({ op: 'hover', node: p.node('#b'), label: 'Other' })).toMatchObject({ ok: false, error: 'changed' });
    expect(p.run({ op: 'hover', node: 99999, label: 'x' })).toMatchObject({ ok: false, error: 'stale' });
  });
});

describe('buildActionScript: press Tab', () => {
  const FIELDS = '<input id="a" aria-label="First"><input id="b" aria-label="Second"><button id="c">Go</button>';

  it('moves focus forward and back and reports the label', () => {
    const p = makePage(FIELDS);
    p.snapshot();
    p.doc.getElementById('a').focus();
    expect(p.run({ op: 'press', key: 'Tab' })).toMatchObject({ ok: true, focused: 'Second' });
    expect(p.doc.activeElement.id).toBe('b');
    expect(p.run({ op: 'press', key: 'shift+tab' })).toMatchObject({ ok: true, focused: 'First' });
    expect(p.doc.activeElement.id).toBe('a');
  });

  it('wraps around at both ends and starts at the first control when nothing is focused', () => {
    const p = makePage(FIELDS);
    p.snapshot();
    expect(p.run({ op: 'press', key: 'Tab' })).toMatchObject({ focused: 'First' });
    p.doc.getElementById('c').focus();
    expect(p.run({ op: 'press', key: 'TAB' })).toMatchObject({ focused: 'First' });
    p.doc.getElementById('a').focus();
    expect(p.run({ op: 'press', key: 'Shift+Tab' })).toMatchObject({ focused: 'Go' });
  });

  it('skips disabled, hidden-type, tabindex=-1 and aria-hidden controls and honours positive tabindex first', () => {
    const p = makePage(
      '<input id="a" aria-label="A"><input id="off" aria-label="Off" disabled><input type="hidden" id="h"><input id="skip" aria-label="Skip" tabindex="-1"><div aria-hidden="true"><input id="hid" aria-label="Hid"></div><input id="z" aria-label="Z" tabindex="1">',
    );
    p.snapshot();
    expect(p.run({ op: 'press', key: 'Tab' })).toMatchObject({ focused: 'Z' });
    expect(p.run({ op: 'press', key: 'Tab' })).toMatchObject({ focused: 'A' });
    expect(p.run({ op: 'press', key: 'Tab' })).toMatchObject({ focused: 'Z' });
  });

  it('does not move focus when the page cancels keydown', () => {
    const p = makePage(FIELDS);
    p.snapshot();
    p.doc.getElementById('a').focus();
    p.doc.addEventListener('keydown', (e: any) => e.preventDefault());
    const res = p.run({ op: 'press', key: 'Tab' });
    expect(res).toMatchObject({ ok: true });
    expect((res as any).focused).toBeUndefined();
    expect(p.doc.activeElement.id).toBe('a');
  });

  it('works before any snapshot and with no focusable controls', () => {
    const p = makePage(FIELDS);
    expect(p.run({ op: 'press', key: 'Tab' })).toMatchObject({ ok: true, focused: 'First' });
    const empty = makePage('<p>nothing here</p>');
    expect(empty.run({ op: 'press', key: 'Tab' })).toMatchObject({ ok: true });
  });

  it('crosses into shadow roots in tab order', () => {
    const p = makePage('<input id="a" aria-label="First"><div id="host"></div>');
    p.doc.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<input aria-label="Inner">';
    p.snapshot();
    p.doc.getElementById('a').focus();
    expect(p.run({ op: 'press', key: 'Tab' })).toMatchObject({ ok: true, focused: 'Inner' });
  });
});

describe('buildActionScript: click opened hint', () => {
  function pageWithLink(attrs: string) {
    const p = makePage(`<a id="l" href="https://example.org/x" ${attrs}>Docs</a>`);
    p.doc.addEventListener('click', (e: any) => e.preventDefault());
    p.snapshot();
    return p;
  }

  it('reports opened for target=_blank in any case', () => {
    for (const attrs of ['target="_blank"', 'target="_BLANK"']) {
      const p = pageWithLink(attrs);
      expect(p.run({ op: 'click', node: p.node('#l'), label: 'Docs' })).toMatchObject({ ok: true, opened: true });
    }
  });

  it('omits opened for same-tab links, downloads and plain buttons', () => {
    for (const attrs of ['', 'target="_self"', 'target="_top"', 'target="_blank" download']) {
      const p = pageWithLink(attrs);
      const res = p.run({ op: 'click', node: p.node('#l'), label: 'Docs' }) as any;
      expect(res.ok).toBe(true);
      expect(res.opened).toBeUndefined();
    }
    const b = makePage('<button id="b">Go</button>');
    b.snapshot();
    expect((b.run({ op: 'click', node: b.node('#b'), label: 'Go' }) as any).opened).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/daemon/src/browser/page-scripts.test.ts -t "hover|press Tab|opened hint"`
Expected: FAIL (`hover` has no body; `Tab` does nothing).

- [ ] **Step 3: Implement**

In `page-scripts.ts`:

(a) Types. `PageOp` gets `| { op: 'hover'; node: number; label: string }`. The ok variant of `PageOpResult` becomes `{ ok: true; label?: string; navigated?: boolean; value?: string; verified?: boolean; opened?: boolean; focused?: string }`.

(b) `PRELUDE` changes. Change `key` and `pressKey` to take an optional shift flag:

```js
  const key = (el, type, k, shift) => {
    const init = { key: k, code: k.length === 1 ? '' : k, shiftKey: shift === true, bubbles: true, cancelable: true, view: window };
    if (k === 'Enter') Object.assign(init, { keyCode: 13, which: 13 });
    return el.dispatchEvent(new KeyboardEvent(type, init));
  };
  const pressKey = (el, k, shift) => {
    const allowed = key(el, 'keydown', k, shift);
    if (k.length === 1 || k === 'Enter') key(el, 'keypress', k, shift);
    key(el, 'keyup', k, shift);
    return allowed;
  };
```

and append to `PRELUDE` (after `deepActive`):

```js
  const FOCUSABLE = 'a[href],button,input,select,textarea,summary,[tabindex],[contenteditable="true"]';
  const tabbables = () => {
    const c = window.__rhFast || window.__jevFast;
    const all = c && typeof c.deepAll === 'function' ? c.deepAll(FOCUSABLE) : Array.from(document.querySelectorAll(FOCUSABLE));
    const ok = all.filter((e) => {
      if (e.matches(':disabled') || (e.closest && e.closest('[aria-disabled="true"]'))) return false;
      if (e.tagName === 'INPUT' && e.type === 'hidden') return false;
      const ti = e.getAttribute('tabindex');
      if (ti !== null && Number(ti) < 0) return false;
      if (c && typeof c.visible === 'function' && !c.visible(e)) return false;
      return true;
    });
    const positive = (e) => Number(e.getAttribute('tabindex')) > 0;
    const first = ok.filter(positive).sort((a, b) => Number(a.getAttribute('tabindex')) - Number(b.getAttribute('tabindex')));
    return first.concat(ok.filter((e) => !positive(e)));
  };
  const moveFocus = (from, backwards) => {
    const list = tabbables();
    if (list.length === 0) return null;
    const i = list.indexOf(from);
    const j = i < 0 ? (backwards ? list.length - 1 : 0) : (backwards ? (i - 1 + list.length) % list.length : (i + 1) % list.length);
    const next = list[j];
    try { next.focus(); } catch (e) { return null; }
    return next;
  };
```

(c) `CLICK` body:

```js
const CLICK = String.raw`
  const link = el.closest ? el.closest('a[href],area[href]') : null;
  const opened = !!link && String(link.getAttribute('target') || '').toLowerCase() === '_blank' && !link.hasAttribute('download');
  reveal(el);
  mouse(el, 'pointerdown', true);
  mouse(el, 'mousedown', false);
  mouse(el, 'pointerup', true);
  mouse(el, 'mouseup', false);
  el.click();
  const result = { ok: true, label: current, navigated: false };
  if (opened) result.opened = true;
  return out(result);
`;
```

(d) New `HOVER` body, added after `CLICK`:

```js
const HOVER = String.raw`
  if (typeof el.scrollIntoView === 'function') {
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
  }
  const emit = (target, type, pointer, bubbles) => {
    const init = { bubbles: bubbles, cancelable: true, view: window };
    if (pointer) {
      if (typeof window.PointerEvent === 'function') target.dispatchEvent(new PointerEvent(type, init));
      return;
    }
    target.dispatchEvent(new MouseEvent(type, init));
  };
  const chain = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null) chain.unshift(n);
  for (const n of chain) {
    emit(n, 'pointerenter', true, false);
    emit(n, 'mouseenter', false, false);
  }
  emit(el, 'pointerover', true, true);
  emit(el, 'mouseover', false, true);
  emit(el, 'pointermove', true, true);
  emit(el, 'mousemove', false, true);
  return out({ ok: true, label: current });
`;
```

(e) `PRESS` body:

```js
const PRESS = String.raw`
  const lower = String(op.key).toLowerCase();
  const backwards = lower === 'shift+tab';
  const k = backwards || lower === 'tab' ? 'Tab' : String(op.key);
  const target = deepActive();
  const allowed = pressKey(target, k, backwards);
  if (k === 'Enter' && allowed && target.tagName === 'INPUT' && target.form) submitForm(target.form);
  if (k === 'Tab' && allowed) {
    const next = moveFocus(target, backwards);
    if (next) {
      const c = window.__rhFast || window.__jevFast;
      const label = String((c && c.name ? c.name(next) : '') || next.tagName.toLowerCase()).replace(/\s+/g, ' ').trim().slice(0, 80);
      return out({ ok: true, focused: label });
    }
  }
  return out({ ok: true });
`;
```

(f) `BODIES` gets `hover: GUARD + RESOLVE + HOVER,`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/daemon/src/browser`
Expected: PASS. (The `.replace(/\s+/g, ' ')` inside the `String.raw` template is correct as written there; `String.raw` keeps the backslash.)

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/browser/page-scripts.ts packages/daemon/src/browser/page-scripts.test.ts
git commit -m "feat(browser): hover, real Tab focus movement and a new-tab hint for links"
```

---

### Task 5: `browser_do` targets elements by label, supports hover, allows 30 steps

**Files:**
- Create: `packages/daemon/src/browser/targets.ts`, `packages/daemon/src/browser/targets.test.ts`
- Modify: `packages/daemon/src/browser/port.ts`, `packages/daemon/src/browser/engine.ts`, `packages/daemon/src/browser/legacy-port.ts`, `packages/daemon/src/computer/tools.ts`
- Test: `engine.test.ts`, `legacy-port.test.ts`, `computer/tools.test.ts`

**Interfaces:**
- Produces:
  - `export type TargetOp = 'click' | 'type' | 'select' | 'check' | 'hover'`
  - `export type TargetResult = { ok: true; el: PageElement & { node: number } } | { ok: false; reason: string }`
  - `export function resolveTarget(state: PageState, op: TargetOp, target: string): TargetResult`
  - `DoStep` gains `target?: string` and `op` gains `'hover'`.
  - `browser_do` accepts at most 30 steps; each of click/type/select/check/hover takes exactly one of `index` or `target`.

- [ ] **Step 1: Write the failing tests for the resolver**

Create `packages/daemon/src/browser/targets.test.ts`:

```ts
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
    const r = resolveTarget(page, 'click', 'email');
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toBe(
      'target "email" is ambiguous (matches [1] textbox "Email address", [2] button "Email"); use index',
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/daemon/src/browser/targets.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the resolver**

Create `packages/daemon/src/browser/targets.ts`:

```ts
import { clean, findElements, type PageElement, type PageState } from './render.js';

export type TargetOp = 'click' | 'type' | 'select' | 'check' | 'hover';

export type TargetResult = { ok: true; el: PageElement & { node: number } } | { ok: false; reason: string };

const CHECKABLE_ROLES = new Set(['checkbox', 'radio', 'switch']);
const SHOWN_CANDIDATES = 5;

function fits(op: TargetOp, el: PageElement): el is PageElement & { node: number } {
  if (typeof el.node !== 'number') return false;
  switch (op) {
    case 'type':
      return el.kind === 'fill';
    case 'select':
      return el.kind === 'select';
    case 'check':
      return CHECKABLE_ROLES.has(el.role) || el.checked !== undefined;
    default:
      return true;
  }
}

const norm = (s: string): string => clean(s, 500).toLowerCase();

const NOUN: Record<TargetOp, string> = {
  click: 'element',
  hover: 'element',
  type: 'text field',
  select: 'dropdown',
  check: 'checkbox or switch',
};

function listed(list: PageElement[]): string {
  const shown = list.slice(0, SHOWN_CANDIDATES).map((e) => `[${e.id}] ${e.role} "${clean(e.label, 60)}"`);
  const more = list.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

/**
 * Resolves a visible label to one element of the shown page: an exact label match first, then
 * a substring match, among elements that fit the op. Zero or several matches fail with the
 * candidates so the caller can pick an index; nothing is ever guessed.
 */
export function resolveTarget(state: PageState, op: TargetOp, target: string): TargetResult {
  const want = norm(target);
  if (!want) return { ok: false, reason: 'target is empty' };
  const pool = state.elements.filter((e): e is PageElement & { node: number } => fits(op, e));
  const pick = (matches: Array<PageElement & { node: number }>): TargetResult | null => {
    if (matches.length === 1) return { ok: true, el: matches[0]! };
    if (matches.length > 1) {
      return { ok: false, reason: `target "${clean(target, 80)}" is ambiguous (matches ${listed(matches)}); use index` };
    }
    return null;
  };
  const exact = pick(pool.filter((e) => norm(e.label) === want));
  if (exact) return exact;
  const partial = pick(pool.filter((e) => norm(e.label).includes(want)));
  if (partial) return partial;
  const near = findElements({ ...state, elements: pool }, target, SHOWN_CANDIDATES);
  const hint = near.length > 0 ? `; closest: ${listed(near)}` : '';
  return { ok: false, reason: `no ${NOUN[op]} matches target "${clean(target, 80)}"${hint}` };
}
```

Run `npx vitest run packages/daemon/src/browser/targets.test.ts` and expect PASS. If the `nexxt` or `checkout now` case shows a `closest:` list, the assertions above still hold because they only anchor the start of the message.

- [ ] **Step 4: Write the failing engine tests**

In `engine.test.ts`, change the existing line that expects an unknown `hover` op and the 15-step limit:

```ts
    await expect(engine.do([{ op: 'drag' as DoStep['op'] }])).rejects.toThrow('step 1 drag invalid: unknown op');
    await expect(engine.do(Array.from({ length: 31 }, () => ({ op: 'wait' as const, ms: 1 })))).rejects.toThrow('at most 30 steps');
```

Add a new `describe` after the `do` block (it reuses `t`, `engine`, `opOf`, `page`):

```ts
describe('do: label targets, hover and limits', () => {
  const twoSaves = (): string =>
    JSON.stringify(page({ actions: [
      { node: 21, role: 'button', label: 'Save', kind: 'click', value: '' },
      { node: 22, role: 'button', label: 'Save', kind: 'click', value: '' },
      { node: 23, role: 'button', label: 'Next steps', kind: 'click', value: '' },
      { node: 24, role: 'button', label: 'Next', kind: 'click', value: '' },
    ] }));

  it('resolves labels against the last shown page and sends the stable ids', async () => {
    await engine.snapshot();
    await engine.do([
      { op: 'type', target: 'email', text: 'a@b.c' },
      { op: 'select', target: 'country', value: 'Canada' },
      { op: 'check', target: 'agree', checked: true },
      { op: 'click', target: 'Next' },
    ]);
    expect(t.actionEvals().map(opOf)).toEqual([
      { op: 'type', node: 7, label: 'Email', text: 'a@b.c' },
      { op: 'select', node: 3, label: 'Country', value: 'Canada' },
      { op: 'check', node: 9, label: 'I agree', checked: true },
      { op: 'click', node: 12, label: 'Next' },
    ]);
  });

  it('takes its own snapshot first when no page has been shown yet', async () => {
    const out = await engine.do([{ op: 'click', target: 'Next' }]);
    expect(t.actionEvals().map(opOf)).toEqual([{ op: 'click', node: 12, label: 'Next' }]);
    expect(t.snapshotEvals()).toBeGreaterThanOrEqual(2);
    expect(out.split('\n')[0]).toBe('did: click');
  });

  it('prefers the exact label over a longer one', async () => {
    t.snapshots = [twoSaves()];
    await engine.snapshot();
    await engine.do([{ op: 'click', target: 'next' }]);
    expect(t.actionEvals().map(opOf)).toEqual([{ op: 'click', node: 24, label: 'Next' }]);
  });

  it('refuses an ambiguous or unknown label before running any step', async () => {
    t.snapshots = [twoSaves()];
    await engine.snapshot();
    const before = t.actionEvals().length;
    await expect(engine.do([{ op: 'click', target: 'Save' }])).rejects.toThrow(
      'step 1 click invalid: target "Save" is ambiguous (matches [21] button "Save", [22] button "Save"); use index. No steps were run.',
    );
    await expect(engine.do([{ op: 'click', target: 'Pay' }])).rejects.toThrow('step 1 click invalid: no element matches target "Pay"');
    expect(t.actionEvals()).toHaveLength(before);
  });

  it('rejects index together with target, and a step with neither', async () => {
    await engine.snapshot();
    await expect(engine.do([{ op: 'click', index: 12, target: 'Next' }])).rejects.toThrow(
      'step 1 click invalid: give either index or target, not both. No steps were run.',
    );
    await expect(engine.do([{ op: 'click' }])).rejects.toThrow('step 1 click invalid: index or target is required. No steps were run.');
  });

  it('sends hover with the stable id', async () => {
    await engine.snapshot();
    await engine.do([{ op: 'hover', index: 12 }, { op: 'hover', target: 'Next' }]);
    expect(t.actionEvals().map(opOf)).toEqual([
      { op: 'hover', node: 12, label: 'Next' },
      { op: 'hover', node: 12, label: 'Next' },
    ]);
  });

  it('accepts 30 steps', async () => {
    await engine.snapshot();
    const out = await engine.do(Array.from({ length: 30 }, () => ({ op: 'wait' as const, ms: 0 })));
    expect(out.split('\n')[0]!.startsWith('did: wait, wait')).toBe(true);
  });

  it('uses the legacy port (no snapshot of its own) when no supported browser runs', async () => {
    t.env = { frontmost: 'Finder', running: [] };
    expect(await engine.do([{ op: 'click', target: 'Next' }])).toBe('legacy:do');
    expect(t.evals).toHaveLength(0);
  });
});
```

Add to `legacy-port.test.ts` (follow the file's existing construction of the port and driver fakes):

```ts
  it('rejects target steps and hover with a message that names the fix', async () => {
    const port = makePort(); // use the same helper the neighbouring do tests use
    await expect(port.do([{ op: 'click', target: 'Next' }])).rejects.toThrow(
      'step 1 click invalid: target is not supported on the slower fallback; use index from browser_snapshot. No steps were run.',
    );
    await expect(port.do([{ op: 'hover', index: 1 }])).rejects.toThrow('step 1 hover invalid: not supported on the legacy path');
  });
```

Change the `tools.test.ts` expectation at the batch test from `steps.0.index: step 1 click needs index.` to `steps.0.index: step 1 click needs index or target.` and add:

```ts
  it('browser_do steps take index or target (not both) and know hover', () => {
    const tool = buildComputerTools(fakeSession()).find((t) => t.name === 'browser_do')!;
    const schema = z.object(tool.inputSchema);
    expect(schema.safeParse({ steps: [{ op: 'click', target: 'Next' }] }).success).toBe(true);
    expect(schema.safeParse({ steps: [{ op: 'hover', index: 3 }] }).success).toBe(true);
    expect(schema.safeParse({ steps: [{ op: 'click', index: 3, target: 'Next' }] }).success).toBe(false);
    expect(schema.safeParse({ steps: [{ op: 'type', text: 'x' }] }).success).toBe(false);
    expect(schema.safeParse({ steps: [{ op: 'click', target: '' }] }).success).toBe(false);
    expect(schema.safeParse({ steps: Array.from({ length: 30 }, () => ({ op: 'wait', ms: 1 })) }).success).toBe(true);
    expect(schema.safeParse({ steps: Array.from({ length: 31 }, () => ({ op: 'wait', ms: 1 })) }).success).toBe(false);
  });
```

(`z` is already imported in that file; if it is not, import it from `zod`.)

- [ ] **Step 5: Run to verify failure**

Run: `npx vitest run packages/daemon/src/browser/engine.test.ts packages/daemon/src/browser/legacy-port.test.ts packages/daemon/src/computer/tools.test.ts`
Expected: FAIL on the new and changed tests only.

- [ ] **Step 6: Implement**

`port.ts`: `DoStep.op` becomes `'click' | 'type' | 'select' | 'check' | 'hover' | 'press' | 'scroll' | 'wait'`; add `/** Visible label of the element, instead of index (fast path only). */ target?: string;` after `index`.

`page-scripts.ts` is done in Task 4. In `engine.ts`:

- `import { resolveTarget, type TargetOp } from './targets.js';`
- `const MAX_STEPS = 30;` and `const INDEX_OPS = new Set<DoStep['op']>(['click', 'type', 'select', 'check', 'hover']);` and add `'hover'` to `ALL_OPS`.
- In `do()`, replace the line `const shown = this.shown?.mode === 'fast' ? this.shown : null;` with:

```ts
    let shown = this.shown?.mode === 'fast' ? this.shown : null;
    if (!shown && steps.some((s) => s !== null && typeof s === 'object' && s.target !== undefined)) {
      // Label targets need a page to resolve against: look at the page first.
      const r = await this.resolve();
      if (r.kind === 'legacy') return this.useLegacy(() => this.legacy.do(steps), r.reason, true);
      try {
        const { ctx: front } = await this.target(r.ctx);
        await this.show(front);
      } catch (err) {
        if (err instanceof BrowserAutomationError) {
          this.transportFailed(r.ctx, err);
          throw new Error(`${err.message} Call browser_snapshot to continue on the slower fallback.`);
        }
        throw err;
      }
      shown = this.shown?.mode === 'fast' ? this.shown : null;
    }
```

- In `planStep`, replace the index block (from `let el: …` through the `if (INDEX_OPS.has(step.op)) { … }`) with:

```ts
  let el: (PageElement & { node: number }) | undefined;
  if (INDEX_OPS.has(step.op)) {
    const hasIndex = step.index !== undefined;
    const hasTarget = step.target !== undefined;
    if (hasIndex && hasTarget) throw invalid('give either index or target, not both');
    if (hasTarget) {
      if (typeof step.target !== 'string') throw invalid('target must be text');
      if (!state) throw invalid('no page has been shown yet');
      const r = resolveTarget(state, step.op as TargetOp, step.target);
      if (!r.ok) throw invalid(r.reason);
      el = r.el;
    } else {
      if (typeof step.index !== 'number' || !Number.isInteger(step.index)) throw invalid('index or target is required');
      const found = state?.elements.find((e) => e.id === step.index);
      if (!found || typeof found.node !== 'number') {
        throw invalid(`index ${step.index} is not on the page I last showed`);
      }
      el = found as PageElement & { node: number };
    }
  }
```

  and in `base` change `index: el ? (step.index as number) : null` to `index: el ? (el.id as number) : null`; add the `hover` case to the `switch`:

```ts
    case 'hover':
      return { ...base, op: { op: 'hover', node: el!.node, label: el!.label } };
```

`legacy-port.ts`: `const MAX_STEPS = 30;`. In the validation `steps.forEach`, right after the `LEGACY_OPS` check add:

```ts
      if (step.target !== undefined) throw invalid('target is not supported on the slower fallback; use index from browser_snapshot');
```

(`hover` is already rejected by `LEGACY_OPS` with `not supported on the legacy path`.)

`tools.ts`:

```ts
const DO_OPS = ['click', 'type', 'select', 'check', 'hover', 'press', 'scroll', 'wait'] as const;

const doStepSchema = z.object({
  op: z.enum(DO_OPS),
  index: stableId.optional(),
  target: z.string().min(1).max(200).optional().describe('Visible label of the element, instead of index. Exact label preferred.'),
  text: z.string().optional(),
  value: z.string().optional(),
  checked: z.boolean().optional(),
  key: z.string().optional().describe('Key name such as Enter, Tab, Shift+Tab, Escape.'),
  delta: z.number().optional().describe('Pixels to scroll; negative scrolls up.'),
  ms: z.number().int().min(0).max(5000).optional(),
  submit: z.boolean().optional().describe('type only: press Enter after typing.'),
});

const ELEMENT_OPS = new Set<(typeof DO_OPS)[number]>(['click', 'type', 'select', 'check', 'hover']);

const REQUIRED_BY_OP: Record<(typeof DO_OPS)[number], Array<keyof z.infer<typeof doStepSchema>>> = {
  click: [],
  type: ['text'],
  select: ['value'],
  check: ['checked'],
  hover: [],
  press: ['key'],
  scroll: ['delta'],
  wait: ['ms'],
};
```

and in the `superRefine` loop, before the existing `for (const field …)`:

```ts
      if (ELEMENT_OPS.has(step.op)) {
        if (step.index === undefined && step.target === undefined) {
          ctx.addIssue({ code: 'custom', path: [i, 'index'], message: `step ${i + 1} ${step.op} needs index or target` });
        } else if (step.index !== undefined && step.target !== undefined) {
          ctx.addIssue({ code: 'custom', path: [i, 'index'], message: `step ${i + 1} ${step.op} takes index or target, not both` });
        }
      }
```

Change `.max(15)` to `.max(30)`. Update the `browser_do` description to the final text in Task 7 (this task only needs "Run up to 30 browser steps" so the schema and text agree; Task 7 rewrites the rest).

- [ ] **Step 7: Run to verify pass**

Run: `npx vitest run packages/daemon/src/browser packages/daemon/src/computer packages/daemon/src/fast-lane`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/daemon/src/browser/targets.ts packages/daemon/src/browser/targets.test.ts packages/daemon/src/browser/port.ts packages/daemon/src/browser/engine.ts packages/daemon/src/browser/engine.test.ts packages/daemon/src/browser/legacy-port.ts packages/daemon/src/browser/legacy-port.test.ts packages/daemon/src/computer/tools.ts packages/daemon/src/computer/tools.test.ts
git commit -m "feat(browser): browser_do targets elements by label, supports hover and up to 30 steps"
```

---

### Task 6: Surface the new-tab and focus hints to the agent

**Files:**
- Modify: `packages/daemon/src/browser/engine.ts` (`click`, `do`)
- Test: `packages/daemon/src/browser/engine.test.ts`

**Interfaces:**
- Consumes: `PageOpResult.opened` / `.focused` (Task 4).
- Produces: after a click that opened a tab, the result ends with `note: that link opens in a new tab; if the page did not change, use browser_tabs then browser_focus to switch to it`; after `press` Tab, the result ends with `focus now on: "<label>"` (last Tab wins). Both go after the page state, never before it.

- [ ] **Step 1: Write the failing tests**

```ts
describe('action hints', () => {
  const NOTE = 'note: that link opens in a new tab; if the page did not change, use browser_tabs then browser_focus to switch to it';

  it('browser_click adds the new-tab note after the state', async () => {
    await engine.snapshot();
    t.actions = [JSON.stringify({ ok: true, label: 'Next', opened: true })];
    const out = await engine.click(12);
    expect(out.split('\n')[0]).toBe('clicked [12] Next');
    expect(out.split('\n').at(-1)).toBe(NOTE);
  });

  it('browser_click adds nothing for ordinary clicks', async () => {
    await engine.snapshot();
    expect(await engine.click(12)).not.toContain('new tab');
  });

  it('browser_do reports the new-tab note once and the last focus move', async () => {
    await engine.snapshot();
    t.actions = [
      JSON.stringify({ ok: true, opened: true }),
      JSON.stringify({ ok: true, focused: 'Second' }),
      JSON.stringify({ ok: true, focused: 'Go "now"' }),
      JSON.stringify({ ok: true, opened: true }),
    ];
    const out = await engine.do([
      { op: 'hover', index: 12 },
      { op: 'press', key: 'Tab' },
      { op: 'press', key: 'Tab' },
      { op: 'hover', index: 12 },
    ]);
    const lines = out.split('\n');
    expect(lines.filter((l) => l === NOTE)).toHaveLength(1);
    expect(lines.at(-1)).toBe('focus now on: "Go \\"now\\""');
  });
});
```

(`hover` returning `opened` is artificial, it only proves the aggregation is op-agnostic; `focus now on:` uses the same escaping as element labels via `clean` plus quote-escaping.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/daemon/src/browser/engine.test.ts -t "action hints"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `engine.ts` add near the other notes:

```ts
const OPENED_NOTE = 'note: that link opens in a new tab; if the page did not change, use browser_tabs then browser_focus to switch to it';

function focusLine(label: string): string {
  return `focus now on: "${clean(label, 80).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
```

`click()`: `const res = await this.act(...)`, then

```ts
    const state = await this.after(ctx, shown.state, false, shown.origin, false, clickConfirm(el));
    return `clicked [${index}] ${clean(el.label)}\n${state}${res.opened ? `\n${OPENED_NOTE}` : ''}`;
```

`do()`: before the loop `let opened = false; let focused: string | null = null;`; after each successful `act` (`res`): `if (res.opened) opened = true; if (typeof res.focused === 'string') focused = res.focused;`; at the end:

```ts
    return [
      `did: ${done.join(', ')}`,
      ...(navigated ? [navigated] : []),
      body,
      ...(opened ? [OPENED_NOTE] : []),
      ...(focused !== null ? [focusLine(focused)] : []),
    ].join('\n');
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/daemon/src/browser packages/daemon/src/fast-lane`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/browser/engine.ts packages/daemon/src/browser/engine.test.ts
git commit -m "feat(browser): tell the agent when a click opens a new tab or Tab moves focus"
```

**Stage B ends here: run the Execution protocol (Codex review of Tasks 4-6).**

---

### Task 7: Prompt, tool descriptions and skill text

**Files:**
- Modify: `packages/daemon/src/computer/tools.ts` (`browser_do`, `browser_snapshot`, `computer_batch` descriptions), `packages/daemon/src/computer/prompt.ts` (rule 5), `packages/cli/src/system/operator-skill.ts`, `.agents/skills/remote-hands-operator/SKILL.md`, `docs/development.md`
- Test: `packages/daemon/src/computer/prompt.test.ts`, `packages/daemon/src/computer/tools.test.ts`, `packages/cli/src/system/operator-skill.test.ts`

**Interfaces:** text only. The tool-name test (`mentions exactly the tool names`) and the `stays identical to the repo skill file` test constrain the wording (see Global Constraints).

- [ ] **Step 1: Write the failing tests**

`prompt.test.ts`, inside `describe('SLIM_COMPUTER_PROMPT', …)`:

```ts
  it('rule 5 teaches label targets, hover, Tab, frames and hidden elements without inventing tools', () => {
    const rule = SLIM_COMPUTER_PROMPT.split('\n').find((l) => l.startsWith('5. Browser')) ?? '';
    expect(rule).toContain('`target`');
    expect(rule).toContain('hover');
    expect(rule).toMatch(/Tab/);
    expect(rule).toMatch(/shadow DOM/);
    expect(rule).toMatch(/another website/);
    expect(rule).toMatch(/more elements hidden/);
    expect(rule).toMatch(/new tab/);
    expect(rule).toContain('Never run `rh browser setup` yourself');
  });
```

`tools.test.ts`:

```ts
  it('browser_do description matches the schema: 30 steps, target, hover, Tab, fallback limits', () => {
    const d = buildComputerTools(fakeSession()).find((t) => t.name === 'browser_do')!.description;
    expect(d).toContain('up to 30');
    expect(d).toContain('target');
    expect(d).toContain('hover');
    expect(d).toContain('Shift+Tab');
    expect(d).not.toContain('up to 15');
    expect(d).not.toContain('Tab and typed keys do not move focus');
    expect(d).toContain('On the slower fallback path only click, type and wait are supported');
  });
```

`operator-skill.test.ts` (inside the stable-id tools test): add `expect(md).toContain('\`target\`'); expect(md).toContain('1-30');`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/daemon/src/computer packages/cli/src/system/operator-skill.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement the text**

`tools.ts` `browser_do` description (replace the whole string):

```
'Run up to 30 browser steps in ONE call, stopping at the first failure. Prefer this for forms and multi-step sequences. Name each element with its stable id (index) from the last state you saw, or with target, its visible label (exact label preferred; an ambiguous or unknown label fails before anything runs and lists the candidates). Use exactly one of index or target on click/type/select/check/hover. Other required fields: type needs text (optional submit); select needs value; check needs checked; press needs key (Enter, Tab, Shift+Tab, Escape); scroll needs delta; wait needs ms (0-5000). hover fires mouse events so menus that open on mouseover appear; menus that use only CSS :hover do not, click them instead. Example: [{"op":"type","target":"Email","text":"me@x.com"},{"op":"click","index":7}]. A click, Enter or submit that navigates ends the batch (remaining steps not run) and the new page state is returned; otherwise the final page state is returned, so do not call browser_snapshot again. Pseudo lines [scroll_down], [scroll_up] and [wait] map to {op:"scroll",delta:560|-560} (down|up) and {op:"wait",ms:...}. Tab and Shift+Tab move focus to the next or previous control and the result says which one has focus; other keys are synthetic key events and do not type text (use type). On the slower fallback path only click, type and wait are supported, and only with index.'
```

`browser_snapshot` description: append `Content inside shadow DOM and same-site iframes is listed like any other element; a note line says when frames from another website cannot be read.` before `Selects and checkboxes…`.

`prompt.ts` rule 5: replace the sentence `Use browser_do to fill and submit a whole form in one call (ids from the last state you saw);` with `Use browser_do to fill and submit a whole form in one call (ids from the last state you saw, or \`target\` with the visible label when you have not seen the page; it also takes hover, and press Tab or Shift+Tab to move focus);` and, immediately before `If a result begins with \`note: fast browser path unavailable\``, insert:

```
Content in shadow DOM and same-site iframes is listed like any other element; when a note says frames from another website cannot be read, use the desktop_* tools for that part. If a note says a link opens in a new tab, use browser_tabs then browser_focus. If a state says more elements hidden, use browser_find or scroll instead of guessing.
```

(Keep everything else in rule 5, including the phrases `selects and checkboxes are set only with browser_do ops select/check`, `Use browser_find before dumping a big page and browser_extract to read long text` and `Never run \`rh browser setup\` yourself`.)

`operator-skill.ts` and `.agents/skills/remote-hands-operator/SKILL.md` (edit both identically): in the tools table change the `browser_do` row to ``| `browser_do` | Run 1-30 browser steps (`click`, `type`, `select`, `check`, `hover`, `press`, `scroll`, `wait`) in one call, naming elements by stable id or by visible `target` label, and return the final page state. |`` and extend the bullet that begins ``- Use `browser_do` to fill and submit a whole form`` with: ``Use `target` (the visible label) when you have not seen the page yet; ambiguous labels fail with candidates. Shadow DOM and same-site iframes are included; frames from other websites are reported in a note.``

`docs/development.md`: in the browser section next to the `Tab pin` / `Fallback and its limits` paragraphs add one paragraph "**Frames, shadow DOM and label targets.**" stating: open shadow roots and same-origin iframes are read (depth 3, 100000 elements scanned), closed shadow roots and cross-origin frames are not (visible cross-origin frames of at least 50 by 50 px are counted in a `note:` line), `browser_do` accepts `target` labels and up to 30 steps, `hover` fires mouse events (not CSS `:hover`), `Tab`/`Shift+Tab` move focus, and a click on a `target="_blank"` link adds a new-tab note.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/daemon/src/computer packages/daemon/src/guidance packages/cli/src/system`
Expected: PASS (including `mentions exactly the tool names`, `stays identical to the repo skill file`).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/computer/tools.ts packages/daemon/src/computer/tools.test.ts packages/daemon/src/computer/prompt.ts packages/daemon/src/computer/prompt.test.ts packages/cli/src/system/operator-skill.ts packages/cli/src/system/operator-skill.test.ts .agents/skills/remote-hands-operator/SKILL.md docs/development.md
git commit -m "docs: teach the agent label targets, hover, Tab, frames and new-tab hints"
```

---

### Task 8: Privacy-safe browser call log

**Files:**
- Create: `packages/daemon/src/computer/call-log.ts`, `packages/daemon/src/computer/call-log.test.ts`
- Modify: `packages/daemon/src/computer/mcp-server.ts`
- Test: `packages/daemon/src/computer/mcp-server.test.ts`

**Interfaces:**
- Produces:
  - `export interface ToolCallRecord { at: string; tool: string; ms: number; ok: boolean; kind?: 'timeout' | 'stale' | 'other' }`
  - `export function callLogPath(homeDir: string): string` → `<home>/.remote-hands/computer/calls.jsonl`
  - `export function classifyError(message: string): 'timeout' | 'stale' | 'other'`
  - `export function appendCallRecord(homeDir: string, record: ToolCallRecord): void` (never throws; keeps only known fields; trims at 200 KB to the newest 1000 lines)
  - `ComputerMcpServerOptions.onCall?: (record: ToolCallRecord) => void`
  - `serveComputerMcp` logs to `os.homedir()` unless `RH_CALL_LOG=0`.
- Privacy: records hold tool name, timing and outcome class only. Never arguments, results, URLs, labels or typed text.

- [ ] **Step 1: Write the failing tests**

`call-log.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendCallRecord, callLogPath, classifyError } from './call-log.js';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-calls-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('call log', () => {
  it('appends one JSON line per call with only the known fields', () => {
    appendCallRecord(home, { at: '2026-10-12T00:00:00.000Z', tool: 'browser_do', ms: 412.6, ok: false, kind: 'stale', url: 'https://secret.test', text: 'hunter2' } as any);
    const lines = fs.readFileSync(callLogPath(home), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ at: '2026-10-12T00:00:00.000Z', tool: 'browser_do', ms: 413, ok: false, kind: 'stale' });
    expect(lines[0]).not.toContain('secret');
    expect(lines[0]).not.toContain('hunter2');
  });

  it('classifies errors by shape, not by content', () => {
    expect(classifyError('error: tool call timed out after 90s')).toBe('timeout');
    expect(classifyError('Element [7]: page changed since the snapshot. Call browser_snapshot.')).toBe('stale');
    expect(classifyError('Index 4 is not on the page I last showed. Call browser_snapshot.')).toBe('stale');
    expect(classifyError('something else')).toBe('other');
  });

  it('never throws when the directory cannot be written', () => {
    const file = path.join(home, 'blocker');
    fs.writeFileSync(file, 'x');
    expect(() => appendCallRecord(path.join(file, 'nested'), { at: 'a', tool: 't', ms: 1, ok: true })).not.toThrow();
  });

  it('trims a large log to the newest lines', () => {
    const file = callLogPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const filler = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ at: String(i), tool: 'browser_do', ms: 1, ok: true })).join('\n');
    fs.writeFileSync(file, `${filler}\n${' '.repeat(200_000)}\n`);
    appendCallRecord(home, { at: 'last', tool: 'browser_do', ms: 1, ok: true });
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(1000);
    expect(JSON.parse(lines.at(-1)!).at).toBe('last');
  });
});
```

`mcp-server.test.ts` (follow the file's existing way of building a server and calling a tool; reuse its helper):

```ts
  it('reports each call to onCall with timing and outcome, never the arguments or result', async () => {
    const records: ToolCallRecord[] = [];
    const tools = [
      { name: 'ok_tool', description: 'd', inputSchema: {}, handler: async () => 'secret result' },
      { name: 'bad_tool', description: 'd', inputSchema: {}, handler: async () => { throw new Error('Element [3]: page changed. Call browser_snapshot.'); } },
    ];
    const server = createComputerMcpServer(tools, { onCall: (r) => records.push(r) });
    await callToolOn(server, 'ok_tool', {});   // use the helper this file already has for invoking a registered tool
    await callToolOn(server, 'bad_tool', {});
    expect(records.map((r) => [r.tool, r.ok, r.kind])).toEqual([['ok_tool', true, undefined], ['bad_tool', false, 'stale']]);
    expect(JSON.stringify(records)).not.toContain('secret');
    expect(records.every((r) => typeof r.ms === 'number' && r.ms >= 0)).toBe(true);
  });

  it('a throwing onCall never breaks the tool call', async () => {
    const tools = [{ name: 't', description: 'd', inputSchema: {}, handler: async () => 'fine' }];
    const server = createComputerMcpServer(tools, { onCall: () => { throw new Error('logger down'); } });
    await expect(callToolOn(server, 't', {})).resolves.toBeDefined();
  });
```

If `mcp-server.test.ts` has no helper for invoking a registered tool, read how its existing tests do it and copy that mechanism into a local `callToolOn`; do not export new production API for tests.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/daemon/src/computer/call-log.test.ts packages/daemon/src/computer/mcp-server.test.ts`
Expected: FAIL (module missing; `onCall` ignored).

- [ ] **Step 3: Implement**

`call-log.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';

/** One computer-use tool call: no arguments, no results, no page content. */
export interface ToolCallRecord {
  at: string;
  tool: string;
  ms: number;
  ok: boolean;
  kind?: 'timeout' | 'stale' | 'other';
}

const TRIM_ABOVE_BYTES = 200_000;
const KEEP_LINES = 1000;

export function callLogPath(homeDir: string): string {
  return path.join(homeDir, '.remote-hands', 'computer', 'calls.jsonl');
}

/** Buckets an error message by its shape so the log never stores page content. */
export function classifyError(message: string): 'timeout' | 'stale' | 'other' {
  if (/timed out after/i.test(message)) return 'timeout';
  if (/Call browser_snapshot|no longer present|not in last snapshot|not on the page I last showed/i.test(message)) return 'stale';
  return 'other';
}

/** Appends a record (known fields only). Never throws: logging must not break a tool call. */
export function appendCallRecord(homeDir: string, record: ToolCallRecord): void {
  try {
    const safe: ToolCallRecord = { at: record.at, tool: record.tool, ms: Math.round(record.ms), ok: record.ok };
    if (record.kind !== undefined) safe.kind = record.kind;
    const file = callLogPath(homeDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(safe)}\n`);
    if (fs.statSync(file).size > TRIM_ABOVE_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().startsWith('{'));
      fs.writeFileSync(file, `${lines.slice(-KEEP_LINES).join('\n')}\n`);
    }
  } catch {
    // best effort
  }
}
```

`mcp-server.ts`: import `os` and the log helpers; add `onCall?: ((record: ToolCallRecord) => void) | undefined;` to `ComputerMcpServerOptions`. Inside the per-tool handler, wrap the existing `serialized(() => withTimeout(...))` result:

```ts
      async (args: any) => {
        const started = Date.now();
        const result = await serialized(() => withTimeout(/* existing async IIFE unchanged */));
        if (opts.onCall) {
          try {
            const record: ToolCallRecord = { at: new Date(started).toISOString(), tool: tool.name, ms: Date.now() - started, ok: result.isError !== true };
            if (result.isError) record.kind = classifyError(result.content[0]?.text ?? '');
            opts.onCall(record);
          } catch {
            // logging must never break the call
          }
        }
        return result;
      },
```

and in `serveComputerMcp` (line ~63): `const server = createComputerMcpServer(buildComputerTools(session), process.env.RH_CALL_LOG === '0' ? {} : { onCall: (r) => appendCallRecord(os.homedir(), r) });`.

Add to `docs/development.md` (same paragraph area as Task 7): where the log lives, that it holds tool name, milliseconds and outcome class only, `RH_CALL_LOG=0` turns it off, and the one-liner `jq -s 'group_by(.tool) | map({tool: .[0].tool, n: length, p50: (map(.ms) | sort | .[length/2|floor])})' ~/.remote-hands/computer/calls.jsonl`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/daemon/src/computer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/computer/call-log.ts packages/daemon/src/computer/call-log.test.ts packages/daemon/src/computer/mcp-server.ts packages/daemon/src/computer/mcp-server.test.ts docs/development.md
git commit -m "feat(computer): privacy-safe per-call log of computer-use tool timings"
```

**Stage C ends here: run the Execution protocol (Codex review of Tasks 7-8).**

---

### Task 9: Whole-branch verification and final Codex review

**Files:** none new (review file `docs/superpowers/reviews/final-codex-review.md`).

- [ ] **Step 1: Full test run**

Run: `npx vitest run packages/daemon packages/cli`
Expected: only the known `screen-capture.test.ts` timeout fails (see Global Constraints). Report the exact counts.

- [ ] **Step 2: Type check the packages touched**

Run: `npx tsc --build packages/daemon packages/cli 2>&1 | tail -20`
Expected: no errors in files this branch touched. If the shared `context-attachment.test.ts` TS2532 errors appear, confirm with `git stash`-free means (`git diff main --stat` shows we did not touch that file) and report them as pre-existing.

- [ ] **Step 3: Real-browser smoke test (read-only, user's machine)**

Run `node scripts/bench-browser.mjs` only if the user has a supported browser open with JavaScript from Apple Events enabled; otherwise report "not run: needs a live browser" instead of claiming it passed. Do not click anything on the user's pages.

- [ ] **Step 4: Final Codex review**

Codex review prompt (fill `<STAGE>` and `<COMMITS>`):

```
You are reviewing commits in the git repository at the current directory. Commits to review, oldest first:
<COMMITS>

Read each diff with `git show <sha>`, and the surrounding code. Look for: correctness bugs, regressions to existing behaviour, edge cases that would break for ordinary people using a browser (iframes, shadow DOM, password fields, huge pages, nested frames, links opening tabs, keyboard focus), privacy leaks (page content, URLs, typed text, passwords in logs or notes), unsafe automation (a wrong element being clicked), missing or weak tests, and wording that is false or misleading. Run `npx vitest run <relevant paths>` to check claims; say what you ran.

Write your review to docs/superpowers/reviews/<STAGE>-codex-review.md and change NO other file. Format: one section per finding, `### [P0|P1|P2|P3] <title>` with `file:line`, a concrete failing scenario (input -> wrong result), and a suggested fix. P0 = data loss / wrong action on a user's account, P1 = broken feature, P2 = edge-case bug or weak test, P3 = nit. End with a "Verified" list of what you checked and ran. No praise, no restating the diff.
```

- [ ] **Step 5: Merge readiness**

Do not merge or push. Report: commit list, test counts, review outcomes, and anything deferred or rejected, to the user.
