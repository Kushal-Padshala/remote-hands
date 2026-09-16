# remote-hands

Send a task to your own computer from your phone. Watch the agent do it in your
real, logged-in browser. Approve anything irreversible before it happens.

## Read this first

remote-hands runs an autonomous agent on your machine with access to your files
and to your signed-in browser sessions — your email, your source control, your
hosting, your bank. Anyone who obtains your credentials for this system obtains
that access. It requires approval for irreversible actions by default, denies on
timeout, and never uses `--dangerously-skip-permissions`. Understand the blast
radius before you run it.

## Status

Under construction. See `docs/superpowers/specs/` for the design and
`docs/superpowers/plans/` for the implementation plan.
