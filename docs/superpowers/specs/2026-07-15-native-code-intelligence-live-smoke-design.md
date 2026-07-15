# Native Code Intelligence Live Smoke Test Design

## Purpose

Validate the newly merged Runner V2 native code-intelligence layer through the
real AI Board website, using a small external project and a complete Build-mode
run rather than invoking the new services directly.

## Fixture project

Create a standalone Git repository outside the AI Board checkout named
`native-code-intelligence-smoke`. It is a dependency-light TypeScript order
summary library with:

- `src/order.ts`, defining `Order` and `OrderStatus`;
- `src/summary.ts`, defining `summarizeOrders`;
- `test/summary.test.ts`, covering paid, pending, and refunded orders;
- `tsconfig.json` and `package.json` with deterministic typecheck and test
  commands;
- `.gitignore` entries for `node_modules`, build output, and coverage;
- one force-tracked generated file and one tracked vendored file to exercise
  repository classification.

The initial project contains a TS2322 error in the summary result and a failing
refund calculation. Dependencies are installed and the baseline failures are
recorded before Runner V2 starts. The repository is committed in its failing
baseline state so Runner V2 can create safe task worktrees.

## Build request

The website Build request asks Runner V2 to fix the type error and implement
correct refund accounting. It explicitly requires the agent to inspect the
project with:

- `repo.manifest`;
- `repo.map`;
- `code.workspace_symbols`;
- `code.definition`;
- `code.references`;
- `code.diagnostics`;
- `fs.patch`, followed by changed-file diagnostics.

It also requires the project typecheck and tests to pass. The request forbids
using arbitrary process execution for code discovery, while still allowing
process execution for installation and verification.

## Live environment

Runner V2 runs from the AI Board checkout against the fixture project, with its
state directory outside both repositories and a dedicated localhost port. The
AI Board development website runs locally on its normal development port.
Runner V2 uses Full Access so native code discovery and project-contained edits
are not hidden behind approval pauses. Existing configured model credentials
are used through the website; no credentials are read from browser storage or
printed to logs.

## Monitoring

Drive the test through the in-app browser:

1. Connect the website to Runner V2.
2. Create a Build discussion for the fixture and select available Architect and
   worker runtimes.
3. Start the Build and monitor the task board, transcript, Runner status, tool
   activity, diagnostics, and pauses.
4. If the Build pauses for its mandatory final handoff, choose the website
   action that applies the integrated result to this disposable fixture.
5. Continue monitoring until the website reports a settled result or a concrete
   failure.

Runner logs and authenticated local control-plane state may be inspected as
supporting evidence, but the Build must be initiated, observed, and handed off
through the website.

## Success criteria

- The website connects to the intended Runner V2 project and displays the live
  Build state.
- The durable audit shows all six read-only repository/code-intelligence tools
  requested by the Build prompt and at least one revision-aware `fs.patch`.
- The mutation result contains changed-file diagnostic metadata rather than an
  analysis crash.
- The Architect reviews and integrates the worker result.
- The final handoff applies through the website without corrupting the fixture
  repository.
- A fresh independent `npm run typecheck` and `npm test` pass in the handed-off
  fixture.
- Any provider, UI, tool, scheduling, or handoff failure is reported with its
  observed state instead of being retried blindly or represented as success.

## Cleanup

Stop only the website and Runner processes started for this test. Preserve the
fixture repository and Runner state for inspection unless the user later asks
to remove them. Do not touch unrelated browser tabs, processes, repositories,
or the pre-existing `.claude/worktrees/` directory.
