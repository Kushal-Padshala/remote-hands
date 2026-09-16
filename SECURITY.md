# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability.

Report it privately through GitHub's security advisory form:

https://github.com/Kushal-Padshala/remote-hands/security/advisories/new

Include what you found, the steps to reproduce it, and, if you can, what you
think the impact is. We will respond as soon as we can and work with you on a
fix and a disclosure timeline before anything is made public.

## Supported versions

remote-hands is pre-1.0. There are no released versions and no long-term
support branches. Only the latest commit on `main` is supported. If you find a
problem, please check that it still reproduces on the current `main` before
reporting it.

## Threat model

This section is the part that matters most in this file. Read it before you
run remote-hands on a machine you care about.

### What this software does

remote-hands runs an autonomous coding/browser agent (`agy`, driving
`browser-harness`) on your own computer. That agent has:

- Filesystem access on the machine it runs on, scoped by whatever workspace
  directories it is pointed at.
- Control of your real, already-signed-in Chrome profile — not a sandboxed or
  logged-out browser. If you are signed into email, source control, a hosting
  provider, or your bank in that browser, the agent can act inside those
  sessions.

The phone app is a thin client on top of Supabase. It does not run the agent
itself; it queues tasks for a daemon on your machine to pick up, and it
watches a live stream of what the agent is doing.

### Who can do what

- **Anyone who obtains your Supabase credentials** (your account session, or a
  leaked daemon token) can queue tasks onto your machine, and those tasks will
  run with the same filesystem and browser access described above. This is
  the primary risk this project introduces. Treat your Supabase login and any
  device-pairing token with the same care you'd give an SSH key to that
  machine.
- **Anyone with access to the machine itself** (physical access, or an
  existing compromise) can already do everything the agent can do, with or
  without remote-hands.
- **A malicious or buggy task prompt** can direct the agent to take actions
  inside your logged-in sessions. The approval gate (below) is the mitigation
  for the irreversible ones; it does not stop the agent from reading things it
  has access to.

### Mitigations the design specifies

These are non-negotiable properties of the design, not aspirations:

- **Row-level security on every table, scoped to the owner.** Every table in
  the Supabase schema carries `user_id` and an RLS policy of
  `user_id = auth.uid()` for select, insert, update and delete. There is no
  table a user can read or write rows they don't own. A second user's session
  is expected to see zero rows belonging to anyone else.
- **The daemon authenticates as the user, not as a service.** It never holds
  or uses the Supabase `service_role` key. It signs in through a
  device-pairing flow and holds a normal user refresh token, scoped to
  exactly what that user's account can do. A leaked daemon token can be
  revoked from the Supabase dashboard like any other user session.
- **Approval is required by default for irreversible actions.** Anything that
  publishes, sends, pays, deletes, pushes, or is otherwise hard to undo stops
  and waits for a decision from the phone before it happens. This is the
  default policy, not an opt-in setting.
- **Denial, not approval, on timeout.** If an approval request goes
  unanswered (default 10 minutes), it expires and the action is denied. The
  agent is not assumed to be safe to leave unattended past that point.
- **`--dangerously-skip-permissions` is never used.** The daemon runs the
  agent under an explicit, per-task allowlist plus the approval hook.
  Anything the allowlist doesn't cover and the hook doesn't explicitly allow
  is auto-denied — the safe failure mode is refusal, not action.
- **Live screenshots are ephemeral, not stored.** Frames from the browser
  screencast go out over a realtime broadcast channel and are not written to
  the database or to storage. If nobody is watching, they are simply lost.
  The two exceptions — the handful of frames attached to a pending approval,
  and an explicit opt-in recording — are stored deliberately, with retention
  limits, and the recording toggle says so.

### Known limitations

Being direct about what is not solved yet:

- **The v1 risk classifier pattern-matches command and script text.** It
  looks for things like a click whose accessible name matches
  `publish|submit|send|delete|pay|...`, known shell command patterns
  (`git push`, `rm -rf`, `npm publish`, and similar), and known-destructive
  navigation paths. This is coarse. It can both **miss** a destructive action
  phrased in a way the patterns don't cover, and **stop** a harmless action
  that happens to match a pattern. It fails toward asking rather than acting,
  but it is not a semantic understanding of what the agent is about to do.
  A more precise, call-level classifier is planned but not yet built.
- **Screenshots can contain anything visible in the browser at that moment**
  — inbox contents, private repository contents, banking information, or
  anything else on screen — not just the specific element being approved.
  Anyone who can view a pending approval, or a stored recording, sees
  whatever was on screen.
- **The approval gate governs tool calls it can classify, not general agent
  behavior.** Reading, navigating, and editing files in a working tree run
  without interruption by design, because pausing on every step would make
  the product unusable. That means the agent can still read data it has
  access to without triggering an approval.
- **This project does not sandbox the browser or the filesystem.** It adds a
  gate in front of specific actions; it does not reduce what the agent could
  reach if the gate were bypassed or misconfigured.

If you are deciding whether to run this on a machine with access to accounts
you care about, the honest summary is: the design tries hard to make the
dangerous path require your explicit, per-action approval from your phone,
and to fail closed when that approval doesn't arrive — but the classifier
deciding what counts as dangerous is pattern-based and known to be
imperfect, and anyone who can queue tasks onto your machine has real access
to it.
