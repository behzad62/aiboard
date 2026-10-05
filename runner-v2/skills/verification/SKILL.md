---
name: verification
description: Gather fresh, task-relevant mechanical evidence before lifecycle submission
---
# Verification

Verify by impact, narrowest first: run the new or changed tests first, then
the owning test file or suite, then direct dependents and affected scope. Do
not run the whole suite by default.

Widen beyond affected scope only for a failure, a shared or public contract
change, or a reviewer-named risk. Stay near the task's validation budget and
justify anything broader in the submission.

Extend or parameterize existing tests before adding new test files where
sensible. Merging or deleting obsolete tests is allowed only with an explicit
`behaviour proven in <test id or file>` statement naming where the behavior
is still proven.

Record durable command or browser evidence for claims that matter to the
assigned task, and preserve exact failures and artifact references. The
submit_task validationScope must truthfully report what changed, what was
verified, the tests actually run with counts, and what was not run and why.
Evidence is factual input for the Architect; never turn a command result into
a semantic verdict.
