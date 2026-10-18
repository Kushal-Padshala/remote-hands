# HUD `/history`: see past chats and continue one

## Goal
In the HUD (Mac and Windows) the person types `/history`, sees their earlier chats, picks one and keeps talking in it,
like a coding agent. Success: the picked chat's earlier messages are shown, and the next message continues the same
agent conversation (the agent remembers it).

## Facts this rests on
- Every finished HUD task is in `~/.remote-hands/local.db` (`tasks`: prompt, result_summary, conversation_id, status, times).
- `agy --conversation <id>` resumes a conversation, also days later, and keeps the same id (checked by hand on a 2-day-old chat).
- `HudCoordinator.currentConversationId` is what a new task continues; the hotkey clears it. `WarmAgySession` already restarts the
  agent with `--conversation` when a task names a different conversation.
- The stored `prompt` is the long wrapped prompt. The person's words are on its first line(s): `Goal: <query>` up to the blank line
  before `Active Environment Context:`.
- Older follow-ups sometimes got a new conversation id each turn, so such chats show as separate entries. Tasks with no
  conversation id (fast-lane one-offs, early failures) cannot be resumed and are not listed.

## Design
### Data (daemon, `guidance/chat-history.ts`, pure and tested)
- `goalOfPrompt(prompt)`: the person's words.
- `buildChatHistory(tasks, limit)`: group tasks that have a `conversation_id` by that id; entry = `{ id, title (first goal, 80 chars),
  updatedAt, turns: [{ goal, answer }] }` (oldest first, answer = `plainSummary(result_summary)`, empty for failed/cancelled
  turns which are kept with a short "Stopped"/"Failed" answer), newest chat first, at most 30 entries, at most 20 turns each.
- Reads `store.listTasks` when the store has it (local store). Otherwise the list is empty and the HUD says "No history here".

### Protocol (JSON lines, both HUDs)
- HUD to daemon: `{"event":"history"}` asks for the list; `{"event":"resume","id":"<conversation id>"}` picks one.
- Daemon to HUD: `{"event":"history-list","items":[{"id","title","when","count"}]}` and
  `{"event":"resumed","id","title","turns":[{"goal","answer"}]}`.
- `when` is a short relative time ("5m ago", "2d ago") made by the daemon, so both HUDs show the same words.

### Daemon
- `HudCoordinator.historyList()` and `resumeChat(id)`: resume stops a running task first (`stopActiveTask`), sets
  `currentConversationId = id`, clears the previous-task digest, and returns the turns. An unknown id answers with an empty
  `history-list` (nothing is switched).
- `SpotlightHudRunner.openInteractivePrompt` gets a 7th parameter (`HudHistory`: `list()`, `resume(id)`); it handles the two events
  and writes the replies to the HUD's stdin.

### HUD (Mac `spotlight-hud.swift`, Windows `Hud.cs` + `HudLogic.cs`)
- Typing `/` shows a list above the pill (a small dark popover, same look as the cards). Rows are commands: `/history  Continue a previous chat`,
  filtered by what is typed. Up/Down move, Enter or click picks, Esc closes. With no matching row the text is a normal message.
- Picking `/history` sends `history`; the same popover shows the chats (title, "N messages, 2d ago"). Esc goes back to the commands.
- Picking a chat sends `resume`. On `resumed`, the HUD goes to the card view (if it is not there), clears the cards, shows each turn as a
  request card plus an answer card, marks the task as done, and puts the cursor in the pill ("Ask a follow-up..."). The next submit is
  an ordinary task and continues the conversation.
- Pure parts (filtering commands, popover selection, relative time parsing, message parsing) live where the Windows logic tests reach them.

## Out of scope
Deleting, renaming or searching chats; history for the cloud (phone) store; merging old chats that have different ids.

## Tests
- Daemon: `goalOfPrompt`, `buildChatHistory` (grouping, order, caps, failed turns, no id), coordinator `resumeChat`
  (sets the conversation, stops the running task, next task carries the id), runner event handling.
- Windows logic tests for the new message parsing and the command filter; Mac verified with the snapshot tool and a live run.
