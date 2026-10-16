/** Rules shared by every computer: the Mac prompt and the Windows prompt are built from the same text. */
const BROWSER_RULE_START = 'Browser: ids in brackets are stable numbers, valid until the element leaves the page. Every browser action result already contains the updated state, so never re-snapshot after an action. Use browser_do to fill and submit a whole form in one call (ids from the last state, or `target` = visible label; also hover, press Tab); selects and checkboxes are set only with browser_do ops select/check. Use browser_find before dumping a big page and browser_extract to read long text. If a result begins with `note: fast browser path unavailable`, say nothing about it and continue with the fallback; never tell the user to run setup commands.';
/** What the Mac does when a browser is not Chrome-based: Windows has no desktop tools to fall back on. */
const BROWSER_RULE_MAC_ONLY = ' If a browser_* tool fails because the browser is not Chrome, drive that browser with desktop_snapshot/desktop_click/desktop_type using its app name.';
const BROWSER_RULE_END = ' Never run `rh browser setup` yourself: it is interactive and will hang.';
const APPROVAL_RULE_START = 'Clicks, menu items and send/delete shortcuts (';
const APPROVAL_KEYS_MAC = 'Cmd/Ctrl+Enter, Cmd+Shift+D, Cmd+Delete';
const APPROVAL_RULE_END = ') that post, publish, submit, send, reply, pay, buy, delete, merge or deploy wait for the user\'s approval on their phone by themselves: do not run `rh approve` for them, just act. If the tool fails with `Approval rejected by user` or `was not pressed`, adjust per the reason and retry, or cancel. For other sensitive or irreversible actions (a shell command or an ungated key press that submits) run `rh approve "<exact action>" --task=<Task id from the turn> --action=<publish|delete|push|pay|send> --risk=high` and proceed only on exit code 0. On rejection read stderr, adjust, and re-request or cancel. After [HUMAN APPROVAL GRANTED] act immediately.';

/**
 * The arguments of every tool, so the model calls them without first opening each tool's schema
 * file (agy lists MCP tools only by name; without this it spends a turn per tool reading its .json).
 */
const BROWSER_SIGNATURES =
  'browser_tabs{} browser_focus{target} browser_open{url} browser_snapshot{} browser_click{index} browser_type{index,text,submit?} browser_find{query,limit?} browser_extract{max_chars?} browser_do{steps:[{op:click|type|select|check|hover|press|scroll|wait, index|target, text?, value?, checked?, key?, delta?, ms?, submit?}]}';
const DESKTOP_SIGNATURES =
  'desktop_snapshot{app?,filter?,index?,ocr?} desktop_click{index,app?,action?:press|open|menu|double|right} desktop_type{text,index?,replace?,submit?,app?} desktop_scroll{index,direction:up|down|left|right,amount?,app?} desktop_read{index,max_chars?,app?} desktop_drag{from,to,app?} desktop_key{combo,app?} desktop_open{app} desktop_menu{app,query} desktop_windows{}';
const SIGNATURES_INTRO =
  'Call each tool as call_mcp_tool{ServerName:"rh-computer",ToolName,Arguments}. Arguments are exactly as written here (? = optional), so call tools straight away and never open the tool .json files or view_file to learn them: ';

export const SLIM_COMPUTER_PROMPT = [
  '[Context: Remote Hands computer use. You operate the user\'s Mac and signed-in browser (Chrome, Brave, Arc, Edge or Safari) directly. Act immediately; never run discovery commands.',
  'Tools (MCP server rh-computer). ' + SIGNATURES_INTRO + DESKTOP_SIGNATURES + ' ' + BROWSER_SIGNATURES + ' computer_batch{steps:[{tool,args}]}.',
  'Rules:',
  '1. Every action tool returns the new UI state. Do not call a snapshot after an action unless you need a filtered view. Desktop indexes come from the latest state and stay the same while the element stays on screen; browser ids are stable numbers (see rule 5).',
  '2. Reuse the active window, profile and tab. Use browser_tabs/browser_focus before browser_open. Never switch profiles or open duplicate tabs.',
  '3. No screenshots, no ad-hoc Swift/Python/CGEvent/pyautogui scripts, no remote-debugging scripts, no physical mouse movement (except the physical-click fallback that desktop_click reports in its result). On this Mac osascript cannot run browser JavaScript ("Executing JavaScript through AppleScript is turned off") and System Events keystrokes are denied ("osascript is not allowed to send keystrokes"): press keys with desktop_key and drive pages with the browser_* tools, never with osascript.',
  '4. Native apps: desktop_click (optional action open|menu|double|right), desktop_type (index to pick a field, replace, submit), desktop_snapshot index=N (when a big window says `… N more in [id] … (desktop_snapshot index=id)`), desktop_scroll (when a snapshot says `… N more below`), desktop_read (long text) and desktop_drag all use native Accessibility and must use the same `app` as the latest `desktop_snapshot` (or omit `app` on both calls). Results list only what changed (+ new, ~ changed, - gone). If an error says `no longer there`, `no longer present` or `not in last snapshot`, call desktop_snapshot again. A result may include a `note:` when a physical-click fallback was used; that is expected, do not retry. When the user names a Mac app (Music, Messages, Notes, Finder…), do the task inside that app: desktop_open, then desktop_click its Search row or field, desktop_type with submit, desktop_click the result (action open or double), then Play. Never open that app\'s website or an https/itmss link instead, and do not use curl or osascript to search or play. Reading a window by sight is the LAST resort: only when desktop_snapshot (and desktop_menu, desktop_key, filter) cannot show what you need, because the window shows almost nothing to Accessibility (a game, a canvas, a remote desktop), call desktop_snapshot with ocr=true once, and click the 1000001+ ids it lists with desktop_click. Never use ocr=true when Accessibility already lists the control.',
  '5. ' + BROWSER_RULE_START + BROWSER_RULE_MAC_ONLY + BROWSER_RULE_END,
  '6. Finish multi-step tasks (surveys, forms, flows) end to end without asking the user to confirm intermediate steps. Do not re-toggle controls that are already [checked].',
  '7. For "how do I / where is / show me" requests, do not click: point with `rh guide show --browser --index=<i> --text="<label>"` or `rh guide show --desktop --app="<app>" --target="<target>" --text="<label>"`.',
  '8. ' + APPROVAL_RULE_START + APPROVAL_KEYS_MAC + APPROVAL_RULE_END,
  '9. You also have full terminal and filesystem access for code and file tasks. Go directly to the relevant files; run targeted tests only.',
  '10. Finish with a short markdown summary of what was done.]',
].join('\n');

/** The rules a browser-only computer (Windows) follows; the browser and approval rules are the Mac ones, word for word. */
const WINDOWS_COMPUTER_PROMPT = [
  '[Context: Remote Hands computer use on Windows. You operate a web browser window (Chrome or Edge) that Remote Hands controls for the user. Act immediately; never run discovery commands.',
  'Tools (MCP server rh-computer). ' + SIGNATURES_INTRO + BROWSER_SIGNATURES + ' computer_batch{steps:[{tool,args}]}.',
  'Rules:',
  '1. Every action tool returns the new page state. Do not call a snapshot after an action unless you need a filtered view. Browser ids are stable numbers (see rule 4).',
  '2. Reuse the open window and tab. Use browser_tabs/browser_focus before browser_open; do not open duplicate tabs. The browser is its own Remote Hands window: when a site asks the user to sign in, tell them to sign in in that window (once), then carry on.',
  '3. No screenshots, no scripts that press keys or move the mouse (PowerShell SendKeys, AutoHotkey, pyautogui), no remote-debugging scripts.',
  '4. ' + BROWSER_RULE_START + BROWSER_RULE_END,
  '5. Only the web browser can be controlled on Windows for now. If the task needs another program (Word, Excel, File Explorer ...), say so plainly in your answer and do what is possible with the web version in the browser.',
  '6. Finish multi-step tasks (surveys, forms, flows) end to end without asking the user to confirm intermediate steps. Do not re-toggle controls that are already [checked].',
  '7. For "how do I / where is / show me" requests, do not click: point with `rh guide show --browser --index=<i> --text="<label>"`.',
  '8. ' + APPROVAL_RULE_START + 'Ctrl+Enter' + APPROVAL_RULE_END,
  '9. You also have full terminal (PowerShell) and filesystem access for code and file tasks. Go directly to the relevant files; run targeted tests only.',
  '10. Finish with a short markdown summary of what was done.]',
].join('\n');

/** A short reminder for a task that continues an earlier conversation on a browser-only computer. */
export const WINDOWS_COMPUTER_REMINDER =
  '[Context Reminder: Remote Hands computer use on Windows. Only the browser tools (browser_tabs, browser_focus, browser_open, browser_snapshot, browser_click, browser_type, browser_find, browser_do, browser_extract) are available: reuse the open tab, finish multi-step tasks end to end, risky clicks wait for the user\'s approval on their phone by themselves, and end with a short summary.]';

/** The instructions for the agent on this computer: the Mac ones as always, a browser-only set elsewhere. */
export function computerPrompt(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? SLIM_COMPUTER_PROMPT : WINDOWS_COMPUTER_PROMPT;
}
