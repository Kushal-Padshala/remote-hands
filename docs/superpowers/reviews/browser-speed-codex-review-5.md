# Codex review 5: browser_do resolves a label when its step runs

Change: in `browser_do`, a label that matches nothing at plan time, in a step after the first, is looked up again
(fresh page read, up to 1.5 s) when the step runs, so one call can click "Add" and type into the field it reveals.
Ambiguous labels, labels of the wrong kind, incomplete steps and an unknown label in step 1 are still refused before anything runs.

Findings and resolutions:

1. P1, a deferred action could run after the call was abandoned or out of time (the check ran only when the lookup failed). Fixed: stop reason checked after every read and right before the step runs. Tests: abort and deadline during the lookup.
2. P1, a late lookup could match a field on another route after an async `pushState`. Fixed: the fresh address (hash ignored) must equal the batch's start address, else the step is not run and the batch ends with a note. Test: route changes after the click's own navigation check.
