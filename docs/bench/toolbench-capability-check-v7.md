# ToolBench v7: native tool capability and efficiency

ToolBench runs one model directly against production native tools. HarnessBench remains the full Architect / worker / reviewer-verifier evaluation using Recoverable Job Service.

The default ToolBench has seven cases: verification and repair, stale-patch recovery, caller navigation with an atomic two-function edit, paged search continuation, exact command arguments plus bounded file/artifact reads, interactive process input/output and project skill use.

**Include browser interaction** replaces the ordinary interactive case with the combined process/browser form workflow. Both profiles have seven cases; the six common cases retain identical fingerprints. Enable it for models used with browser tools. The ordinary profile needs no browser backend.

Tokens, calculated/provider-reported cost and elapsed seconds measure efficiency. Per-case emergency guards are 5,000,000 input tokens, 750,000 output tokens, 300 model calls, 900 tool calls and 4,500 seconds. They protect credits against runaway behavior; they are not expected consumption or performance targets. Deterministic behavioral checks, scope checks and required native-tool evidence still determine qualification.

The output case emits about 287 KiB but places the required fact near the beginning. This tests retrieval beyond the inline tail and the old 128 KiB retention window with a small number of reads. Reading large amounts repeatedly adds no qualification value; repeated artifact offsets fail the case. Full command artifacts and `artifact.read` use the same session store, with readable text metadata for UTF-8 output.

New identities are `toolbench-native-capability-v7` and `toolbench-native-capability-browser-v7`, case version `7.0.0`, scorer `solo-toolbench-capability-v7`. Historical v4/v5/v6 packs remain readable with all 27 original case fingerprints preserved. Browser and non-browser profile results should be compared within the same profile.

Deterministic tests use scripted models, real tools, hidden verifiers and deliberate negative controls. They establish fixture/tool correctness, not the quality of a live model. Paid calibration has not been run for this revision.
