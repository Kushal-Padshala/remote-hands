Line numbers refer to `HEAD` (`dd8edfd`).

1. **[P1] [render.ts:263](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/browser/render.ts:263) — The pilot interprets text deltas as complete page text.**  
   `Question\nPick one` → append `Email is taken` → `parseRendered()` replaces the question with just `Email is taken`. Removing the error emits `text gone:`, which the parser ignores, leaving the obsolete error as current text. Same-document full fallbacks also supply partial text and now suppress `BrowserPilotEnv`’s previous full-text reread. **Fix:** distinguish partial text in the protocol and update parser/env to refresh complete text. Existing parser round-trip tests check elements, missing this regression.

2. **[P2] [render.ts:261](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/browser/render.ts:261) — Shortened URLs reset the pilot’s answer protection.**  
   A URL longer than 100 characters → select “Yes” → the delta’s truncated URL replaces `PilotView.url`. `runPilot()` interprets this as another page and clears `pilotChecked`, offering “No” again. Reproduced: the parent prevents switching; HEAD executes Yes followed by No. **Fix:** preserve `prev.url` when parsing a same-page header.

3. **[P2] [render.ts:255](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/browser/render.ts:255) — Captured text is assumed to have been shown.**  
   Default `snapshot()` captures `Email is taken\nPassword too short` but renders neither. Correcting Email leaves `Password too short`; the result shows only `text gone: Email is taken` plus the changed input. The model never learns the remaining error, whereas the parent emitted it. `find()` can similarly establish an unseen text baseline. **Fix:** track text actually delivered, including truncation, and include current context when the baseline was never shown.

4. **[P2] [render.ts:183](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/browser/render.ts:183) — Equal multisets hide changed text associations.**  
   With unchanged controls, `Name\nRequired\nEmail` → `Name\nEmail\nRequired` moves the validation error between fields but returns `no visible change`. The parent showed the new order. Counting duplicates does not preserve their association with surrounding text. **Fix:** detect order changes separately and emit the affected current context instead of declaring no change.

5. **[P2] [render.ts:165](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/browser/render.ts:165) — Whitespace normalization misses internal runs.**  
   `Create  account` → `Create account`, with identical controls and collapsed browser whitespace, emits `text: Create account`. Consequently, `after()` skips the confirmation read and omits password-hidden/unverified notes. The new whitespace test covers only trimming and blank lines. **Fix:** normalize internal visible whitespace before comparing lines.

Fine: increasing duplicate counts and changes to rendered control labels/values remain detectable.

Fine: genuinely unchanged snapshots retain working confirmation, password-hidden, and unverified-note suffix checks.

Fine: legacy-port does not call these renderers; the `changed:` prefix consumers remain compatible.
---
Resolution: the whole change (new-text-only deltas, shortened same-page url, text in full renders) was reverted. The fast-lane pilot parses this text as a protocol (browser/render.ts is mirrored in fast-lane/pilot/parse.ts), so a delta that is not the whole page text breaks it (findings 1, 2), and findings 3-5 show a diff of text the model may never have been shown is not safe. The saving (about 450 characters per turn of input) is not worth that risk; fewer turns is the lever, not shorter turns.
