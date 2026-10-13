### [P2] Window focus still reassigns previously published tab labels

File: `packages/daemon/src/browser/cdp-transport.ts:433`; consumer: `packages/daemon/src/browser/engine.ts:808`.

`windowIndex: w + 1` uses foreground order as the public window number. Reproduced with one tab per window: A/B are `w1-t1`/`w2-t1`; bringing B forward makes B/A `w1-t1`/`w2-t1`. `browser_focus("w1-t1")`, issued using the earlier listing, resolves B instead of A because the engine lists again before matching. Stable per-tab numbers do not fix the window-label part of the original finding.

Suggested fix: keep public window identity separate from foreground ranking, or resolve published labels through a saved target-ID mapping and reject removed targets. Add an engine regression that focuses a label from the previous listing after foreground-window order changes.

### [P2] Moving a tab between windows produces duplicate labels

File: `packages/daemon/src/browser/cdp-transport.ts:402`.

`tabNumber` is keyed only by target ID, but its numbers are allocated separately per window. Reproduced: A in window 10 and B in window 20 each receive t1. Drag A into window 20 without closing either tab. A retains its old number, and the next listing contains two `w1-t1` rows. `matchTab` returns A for that label, so B cannot be selected by its displayed label. Moving a higher-numbered tab can also collide with a later allocation because the destination counter is not advanced.

Suggested fix: track the window associated with each allocation and assign a free destination number when it changes, or use public identities independent of physical window membership. Preserve identity through a published-label mapping if old labels must remain usable. Test tab moves into both empty and populated windows and assert unique labels and correct engine resolution.

### [P2] Numeric focus targets disagree with the new gapped tab numbers

File: `packages/daemon/src/browser/engine.ts:229`; new numbering: `packages/daemon/src/browser/cdp-transport.ts:435`.

Reproduced in one window: A/B/C receive t1/t2/t3. After closing A, the output lists B as `w1-t2` and C as `w1-t3`, but `browser_focus("2")` is converted to a number and selects C through `tabs[target - 1]`. Target 3 also selects C through the `tabIndex` fallback. The tool describes its target as a tab index, yet the only displayed indices no longer agree with that lookup. The closure regression tests the transport rows without exercising numeric engine targets.

Suggested fix: define one numeric addressing scheme and make its displayed numbers and lookup agree. Either resolve stable tab numbers in a specified window, or publish a separate global ordinal and resolve only that ordinal; do not mix array position and persistent tab number. Add a one-window closure regression through the tool/engine, including refusal of a removed number.

### [P2] Missing document focus can keep a minimized window as the current window

File: `packages/daemon/src/browser/cdp-transport.ts:414`.

After A has been observed focused, minimize A and activate B with keyboard focus in B's address bar. Neither document has focus; A's page is hidden and B's selected page is visible. The code retains A solely because its ID is still present. The reproduced listing keeps A at window 1 and marks its hidden page active through the fallback at line 426, so an unpinned snapshot reads A rather than B. A foreground browser window can have no focused document when its own controls have focus; this is explicitly distinguished from window attention in the [HTML focus model](https://html.spec.whatwg.org/multipage/interaction.html#focus).

Suggested fix: treat absent document focus as an unknown signal rather than evidence that the last window is still foreground. Use an actual window-activation signal where available, exclude known minimized windows from inferred foreground selection, and preserve explicit pins when foreground cannot be established. Cover address-bar/DevTools focus and minimized-window transitions; the current mocked focus test only models focus moving between documents or to another application.

### [P2] An old connection attempt can erase a newer in-flight entry and leak a socket

File: `packages/daemon/src/browser/cdp-transport.ts:341`; same cleanup race: `packages/daemon/src/browser/cdp-transport.ts:312`.

Start attempt A, reset connections with `dropConnections`, then start attempt B for the same target. When A finishes, its generation check closes A, but its unconditional `finally` deletes B's entry from `connecting`. A third caller can now start C while B is opening; B and C both pass the current generation check and overwrite the same connection cache entry. The controlled reproduction opened three sockets and left B open after the final `dispose`. The same unconditional clearing exists for `browserConnecting`. This can occur during recovery from a failed environment probe, which calls `dropConnections`, as well as disposal followed by reuse. The added test covers late completion after disposal without a newer attempt.

Suggested fix: clear an in-flight entry only if it still references the completing attempt, and close any superseded cached connection. Apply the identity check to both page and browser attempts. Add a delayed-open regression spanning reset, a newer open, completion of the old open, and a third caller; assert every socket closes.

### [P2] The new two-window live test does not verify the shown tab's identity

File: `packages/daemon/src/browser/cdp-transport.live.test.ts:127`.

The server returns the same title and `Hello` body for every path. If opening `third-page` creates the requested tab but the engine snapshots and pins an existing tab, all assertions in this test can still pass: the output includes the requested `opened` heading, two windows exist, extraction of the wrong page contains `Hello`, and the requested URL exists somewhere in the list. Merely creating the second window before `engine.open` also does not force creation into a different window from the engine's pre-open selection. This leaves the original wrong-window binding scenario untested by the claimed live regression.

Suggested fix: return unique content per route, assert the returned page URL/content and subsequent extraction identify the newly created target, and explicitly arrange activation between the pre-open listing and creation so the created window differs from the saved window. Check target IDs and window IDs before and after.

### Verified

Reviewed commit `dadf645ef4d07d02e5125ffdadca503611cbadd5` against its parent and all seven findings in `docs/superpowers/reviews/windows-w1-codex-review.md`.

- Sent evaluation replay: lost connections and timeouts do not resend the expression; `CdpNotSent` retries once on a new connection. The lost-response test executes the click expression once. Engine action errors propagate without automatic legacy replay.
- New-tab binding: CDP returns the created target ID, and the engine uses it even when absent from the post-open list instead of substituting an old tab. The injected transport/engine regression checks evaluation target IDs.
- Foreground detection and label stability: checked the document-focus probe, explicit `frontWindow` updates, closure gaps, window reorder, tab movement and numeric matching; defects are above.
- Concurrent connections: ordinary simultaneous callers share one promise. Reset overlapping a newer attempt still leaks as reproduced above.
- Launch error: `default-cdp.ts` now retains `ChromeManager`'s structured error; `BrowserUnavailableError` reaches the engine's legacy reason. Checked `envProblem` clearing on success and replacement on failure; no separate stale-reason defect established.
- Live second-tab test: its distinct pathname now avoids same-path reuse, and its count/target-ID assertions establish creation. The new two-window identity assertions remain insufficient as described above.
- Mac path: the darwin session still selects `AppleScriptTransport` and auto-enable. Its `openUrl` still returns void, and the engine retains the prior selection branch for that result.

Ran:

```sh
npx vitest run packages/daemon/src/browser/cdp-transport.test.ts packages/daemon/src/browser/default-cdp.test.ts packages/daemon/src/browser/engine.test.ts packages/daemon/src/browser/transport.test.ts packages/daemon/src/chrome-manager.test.ts packages/daemon/src/computer/session.test.ts packages/daemon/src/computer/session-engine.test.ts
```

Result: **7 files passed, 238 tests passed**.

Attempted:

```sh
RH_LIVE_CDP=1 npx vitest run --project @remote-hands/daemon packages/daemon/src/browser/cdp-transport.live.test.ts
```

Result: setup failed with `listen EPERM` on `127.0.0.1`, then the 60-second setup hook timed out; **5 tests skipped**. No live assertion was executed. This sandbox restriction is not reported as a product defect.

Ran additional source-bundled, in-memory reproductions from `/tmp` for window-label reassignment, duplicate labels after a tab move, numeric focus with closure gaps, minimized-window fallback, and overlapping connection generations. No reproduction used the person's browser or accounts. Only this review file was added; existing `.gitignore` and `.gitattributes` working-tree changes were left untouched.
