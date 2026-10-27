# ToolBench v7: native tool capability and efficiency

ToolBench runs one model directly against production native tools. HarnessBench remains the full Architect / worker / reviewer-verifier evaluation using Recoverable Job Service.

The single ToolBench has seven cases: verification and repair, stale-patch recovery, caller navigation with an atomic two-function edit, paged search continuation, exact command arguments plus bounded file/artifact reads, combined browser form interaction and owned interactive process input/output, and project skill use.

**Browser interaction is required, not optional.** The browser/process case verifies page navigation, form entry, submission, saved state, process input/output and cleanup in one case. The Run tab shows no checkbox or alternate ToolBench pack. A configured browser backend is required for the unified benchmark.

Tokens, calculated/provider-reported cost and elapsed seconds measure efficiency. Per-case emergency guards are 5,000,000 input tokens, 750,000 output tokens, 300 model calls, 900 tool calls and 4,500 seconds. They protect credits against runaway behavior; they are not expected consumption or performance targets. Deterministic behavioral checks, scope checks and required native-tool evidence still determine qualification.

The output case emits about 287 KiB but places the required fact near the beginning. This tests retrieval beyond the inline tail and the old 128 KiB retention window with a small number of reads. Reading large amounts repeatedly adds no qualification value; repeated artifact offsets fail the case. Full command artifacts and `artifact.read` use the same session store, with readable text metadata for UTF-8 output.

The single new-run suite is `toolbench-native-capability-browser-v7`, with case version `7.0.0` and scorer `solo-toolbench-capability-v7`. Previously issued results under both v7 suite identities remain readable, as do v4/v5/v6 fixtures; the historical `toolbench-native-capability-v7` non-browser profile is not selectable for new runs. Compare results within the same recorded suite ID and runner configuration.

Deterministic tests use scripted models, real tools, hidden verifiers and deliberate negative controls. They establish fixture/tool correctness, not the quality of a live model. Paid calibration has not been run for this revision.
