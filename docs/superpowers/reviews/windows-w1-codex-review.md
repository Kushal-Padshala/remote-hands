### [P0] Do not replay an evaluation whose action may already have executed

File: `packages/daemon/src/browser/cdp-transport.ts:390` (retry loop at line 370).

Chrome can execute a click or submit and then lose the WebSocket before its response arrives. The catch block reconnects and sends the same expression again. A same-document handler can therefore send a message twice, submit two requests, or toggle a setting back; the engine's document-origin guard still passes because the document did not change. An in-memory reproduction that executes the action and closes the first connection returned `ok` after **two action executions**. The transport cannot infer that a disconnected request was never executed.

Suggested fix: reconnect for subsequent calls, but fail the current evaluation with an explicit unknown-outcome message once it has been sent. Only retry operations explicitly classified as read-only, or failures proven to occur before sending. Add a lost-response regression using an actual action script.

### [P0] Opening in another window binds subsequent actions to the old page

File: `packages/daemon/src/browser/cdp-transport.ts:409` (discarded `_windowId`); consumer: `packages/daemon/src/browser/engine.ts:826`.

`FastBrowserEngine.open` records window A and passes its ID to `openUrl`. If the person switches to window B before the creation request, Chrome's `/json/new` can create the tab in B. The transport ignores the requested window and discards the returned target ID. The engine then searches only A, falls back to A's existing active tab, and pins that page. The reproduced result was `opened https://new.example/` followed by the snapshot of `https://old.example/`; its readiness and snapshot scripts ran in the old tab. A later click/type can thus affect the old account or page. Chrome's creation implementation uses a foreground-tab navigation without the caller's window ID. [Chromium implementation](https://chromium.googlesource.com/chromium/src/+/4d54f0a8e47abbf6d5d401c7d09a43ec2994d130/chrome/browser/devtools/chrome_devtools_manager_delegate.cc).

Suggested fix: carry the created target ID back to the engine and bind the snapshot/pin to that exact target, regardless of window activation races. Honor the requested window when supported, and fail explicitly rather than substituting an existing tab when creation cannot be confirmed. Add a two-window test that switches windows between listing and creation.

### [P1] Tab visibility and list recency do not identify the foreground window

File: `packages/daemon/src/browser/cdp-transport.ts:324` (visibility probe at line 313).

With two visible Chrome windows, each selected tab reports `visible`. If A's tab was selected more recently, bringing the already-visible window B to the foreground need not change either page's visibility or `/json/list` ordering. This implementation still numbers A as window 1. The engine selects A for an unpinned snapshot, and can abandon an explicit pin to B on the next snapshot because it falsely concludes that the person switched back to A. This breaks the requested current-tab behavior. Chromium sorts the list by page activity; its visibility update returns immediately when visibility is unchanged. These are not measurements of window focus. [List ordering](https://chromium.googlesource.com/chromium/src/+/main/content/browser/devtools/devtools_http_handler.cc), [visibility update](https://chromium.googlesource.com/chromium/src/+/513bdf4e63d05cd9e79649c177338337a027be1c/content/browser/web_contents/web_contents_impl.cc).

Suggested fix: obtain a separate focus signal, such as a guarded `document.hasFocus()` probe plus explicit-target bookkeeping, instead of treating visibility/recency as foreground ordering. Preserve an explicit target when focus is unknown. Test activation of another already-visible window without changing its selected tab, including a snapshot after `browser_focus`.

### [P2] Closing a tab changes surviving tab labels

File: `packages/daemon/src/browser/cdp-transport.ts:342` (window labels are also rebuilt at line 325).

The persistent `order` map preserves sorting, but `tabIndex: i + 1` assigns fresh labels on every listing. Reproduced: A/B/C are labeled t1/t2/t3; closing A makes B/C t1/t2. An agent that previously saw B as `w1-t2` and then calls `browser_focus("w1-t2")` silently focuses C, because `focus` lists again before resolving the label. Similarly, reordering two windows reassigns their w labels. The existing stability test only changes list order within a window and does not cover closure or window-label reuse.

Suggested fix: resolve displayed labels against the identities from the last published tab listing and reject removed targets, or allocate persistent window/tab labels with gaps. Keep foreground ranking separate from stable public labels. Add closure and two-window reordering regressions.

### [P2] Concurrent connection opens leak untracked WebSockets

File: `packages/daemon/src/browser/cdp-transport.ts:269`; same race at line 255.

Two evaluations of the same target can both observe an empty connection cache, each await a separate WebSocket open, and overwrite the same map entry. The first socket stays open but is no longer reachable by pruning or `dispose`. The in-memory reproduction opened two sockets and left **one open after disposal**. Concurrent `listTabs` calls can likewise overwrite `browserConnection` and duplicate the connections to all 60 pages. Sharing the browser-start promise does not protect connection creation.

Suggested fix: cache an in-flight connection promise per target and for the browser socket; remove failed entries safely and close any superseded connection. Ensure disposal also handles opens already in progress. Test concurrent opens and assert that every created socket is closed after disposal.

### [P2] The default transport discards the actionable browser launch error

File: `packages/daemon/src/browser/default-cdp.ts:38`.

On a machine without Chrome or Edge, or when spawning the executable fails, `ChromeManager.ensureRunning` returns the new plain-language `error`. This adapter reduces that result to `.available`, and `environment` returns only an empty running list. The engine falls through to the legacy port with no startup reason, so the installation/start instructions never reach the person. A mocked missing-browser status reproduced `{ frontmost: null, running: [] }` with the error entirely lost.

Suggested fix: retain the structured launch failure and surface its message through the engine's fallback/error result. Also distinguish a failed debugger-readiness wait from an ordinary absence of a running browser. Add an adapter/engine integration test asserting that the person receives the launch error.

### [P2] The live second-tab test actually reuses the first page

File: `packages/daemon/src/browser/cdp-transport.live.test.ts:94`.

``engine.open(`${url}?second=1`)`` has the same host and pathname as the first page. `FastBrowserEngine.open` therefore takes `navigateReused`, rather than calling `CdpTransport.openUrl` to create a second tab. The subsequent count assertion already succeeds with the initial `about:blank` tab and the first page created in setup. The test can pass without creating the alleged second page or verifying its identity, leaving the new-tab binding defect uncovered.

Suggested fix: open a different pathname, compare target IDs/counts before and after, and assert the focused/snapshotted URL after switching. Add a separate two-window creation case.

### Verified

Reviewed commit `1c0c0359b14d30a4bbbf2d65e7ae3a9a1555eebd`, its parent diff, the W1 Review Focus list, and the transport's engine consumers.

Ran:

```sh
npx vitest run packages/daemon/src/browser/cdp-transport.test.ts packages/daemon/src/browser/default-cdp.test.ts packages/daemon/src/chrome-manager.test.ts packages/daemon/src/browser/engine.test.ts packages/daemon/src/browser/transport.test.ts packages/daemon/src/browser/auto-enable.test.ts packages/daemon/src/computer/session.test.ts packages/daemon/src/computer/session-engine.test.ts packages/cli/src/commands/browser.test.ts packages/cli/src/commands/browser-setup.test.ts
```

Result: **10 files passed, 311 tests passed**.

Attempted:

```sh
RH_LIVE_CDP=1 npx vitest run packages/daemon/src/browser/cdp-transport.live.test.ts
RH_LIVE_CDP=1 npx vitest run --project daemon packages/daemon/src/browser/cdp-transport.live.test.ts
RH_LIVE_CDP=1 npx vitest run --project @remote-hands/daemon packages/daemon/src/browser/cdp-transport.live.test.ts
```

The first command failed during configuration with `listen EPERM` on the Cloudflare inspector port. `daemon` did not match a project name. The correctly named project reached live setup but its local HTTP listener also failed with `EPERM`; setup timed out and all four tests were skipped. The live assertions could not be rerun in this sandbox. This is not counted as a product defect.

Ran additional in-memory reproductions against bundled source for action replay, creation in another window, surviving-tab renumbering, concurrent-socket disposal, and discarded startup errors. No reproduction used the person's browser or accounts.

The darwin session branch retains AppleScript, auto-enable, the legacy port and gate wiring. Windows executable lookup was exercised with fake paths containing spaces/non-ASCII characters by the selected tests; Windows processes were not executed on this Mac.
