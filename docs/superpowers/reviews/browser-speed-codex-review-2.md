1. **[P1] [mcp-server.ts:72](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/mcp-server.ts:72)** — `desktop_read({index:1,max_chars:10000})` on an 8,000-character, single-line document now returns only its element header and a truncation note: `fitResult` keeps the header, then drops the entire oversized body line. Smaller `max_chars` returns only the beginning; `desktop_read` has no offset, so the remainder becomes inaccessible. **Fix:** add bounded paging to `desktop_read` and preserve its continuation information through result fitting.

2. **[P2] [extract.ts:33](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/browser/extract.ts:33)** — The 3,000-byte budget covers only the body. A 150-character Japanese title, long URL, and 3,000-byte ASCII body produce a **3,922-byte** result; `fitResult` then removes both the entire body and `offset=3000` continuation. `computer_batch` status lines cause the same failure even with ASCII headers: reproduced a 3,904-byte batch reduced to headers and statuses. **Fix:** budget the complete response, including headers, continuation, and batch metadata; shorten the body while retaining an accurate next offset.

3. **[P2] [mcp-server.ts:60](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/mcp-server.ts:60)** — SDK argument-validation errors bypass the registered callback and therefore bypass `fitResult`. Calling `browser_do` with 30 steps `{op:"type",index:"3",text:3,submit:"true"}` returns a **6,110-byte** error without invoking the handler. **Fix:** apply budgeting at the final MCP response boundary, including SDK-generated errors.

4. **[P3] [extract.ts:32](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/browser/extract.ts:32)** — A schema-valid, explicitly supplied offset can split a surrogate pair. With text `"a".repeat(199) + "😀hello"`, `{offset:200,max_chars:200}` returns a body beginning with lone low surrogate `\uDE00`. Only the ending boundary is protected. **Fix:** normalize the starting boundary too, keeping the displayed and continuation offsets consistent.

5. **[P3] [page-scripts.ts:533](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/browser/page-scripts.ts:533)** — `<main><span>${"a".repeat(200)}</span>\n</main>` with `max_chars:200` produces `more:true` and `offset=200`, although the follow-up contains no text. `add()` sets `truncated` before checking whether the following node contains only whitespace. This creates an unnecessary paging turn. **Fix:** normalize and reject empty text before testing `full`; distinguish actual omitted text from whitespace.

6. **[P3] [result-budget.ts:30](/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/computer/result-budget.ts:30)** — `fitResult("xx",1)` returns **154 bytes**, exceeding its supplied budget. Negative available space is clamped for the body, but the full truncation note is always appended. Current production callers use the default budget. **Fix:** include the note in the budget calculation and shorten or omit it when necessary.

No additional bugs found in CRLF handling, paging with returned offsets, legacy forwarding, offsets past the end, or schema/prompt argument-name parity.
---
Resolution (stage 2 fixes):
1. desktop_read is exempt from the size cut (`keepWhole`): its result is the text itself and cannot be read in parts. Any other result whose body is one huge line now keeps the start of that line.
2. browser_extract budgets the whole response (header + text + continuation line); computer_batch is left to the line cut.
3. SDK argument-validation errors bypass the callback: not fixed (rare; only a badly malformed 30-step call produces one that large).
4. An offset inside a surrogate pair now starts at the pair.
5. Whitespace after the last character that fits no longer counts as more text.
6. fitResult never exceeds its budget, note included.
