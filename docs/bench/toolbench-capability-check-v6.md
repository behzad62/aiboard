# ToolBench capability check (v6.2)

> Historical v6 profile. New runs use [ToolBench v7](./toolbench-capability-check-v7.md); its optional browser check and larger emergency ceilings supersede the new-run instructions below.

ToolBench qualifies whether a single model can operate AIBoard's native tools. It is **not** an intelligence ranking or a substitute for HarnessBench's end-to-end software-development evaluation.

## New-run profiles

- **ToolBench: capability check** (`toolbench-native-capability-v6`): seven tests:
  1. Red/green verification with a surgical native patch.
  2. Recovery from a stale-context patch rejection.
  3. Repository search and caller navigation, plus **two related fixes in one atomic native patch** (separate patch calls do not qualify).
  4. Cursor-based search continuation.
  5. **Exact two-item command argv** (including a space inside one argument), retrieval from truncated stdout artifacts, and **a bounded ≤64-line file read** to retrieve a second value.
  6. **One integrated case**: owned interactive process + web server, browser form fill and submit, observable saved state, stdin input/EOF and explicit server cleanup.
  7. Project skill discovery, reading, and application.
- Browser interaction is **mandatory within case 6** rather than a separate optional profile. One server/process fixture exercises both process IO and the browser form; it requires a configured browser backend.

There is **one ToolBench profile and one score** with seven cases. The Run UI has no browser checkbox or second ToolBench pack. A configured Runner browser backend is required to complete the whole benchmark.

## Explicit exclusions

- Native core variant B is a historical small data variation, not a distinct qualification benchmark.
- The older standalone investigation, bounded-read, command-argument and atomic-edit cases are not run by default. The v6.1 navigation case **independently requires atomic multi-edit**, and the artifact case **independently requires bounded file reads and exact command argument arrays**. Their behavioral and recorded-tool checks must all pass; no extra cases are added.
- The standalone browser click and project-skills packs were superseded by their broader v6 counterparts.
- Historical v4/v5 packs are still programmatically readable to preserve old evidence and targeted regression tests; the Run tab no longer offers them.

## Guardrails and scoring

All v6.2 cases carry a new case version and scoring identity, so previous v6.1, v6.0, v5 and v4 results cannot silently mix. Case 6 allows 36 model calls and 96 tool calls because it combines process and browser behavior; other cases retain 24/64. Each v6 case has emergency ceilings of **300 seconds, 24 model calls, 64 tool calls, 120,000 input tokens and 24,000 output tokens**, reduced from the old v4/v5 **4,500 seconds, 300 model calls, 900 tool calls, 5 million input tokens and 750,000 output tokens**. These are ceilings, not expected consumption.

Deterministic behavior, required native-tool evidence, protected-file scope, prohibited tool calls, process ownership, and hidden verifiers remain mandatory. Run real-model calibration separately; deterministic test passing does not establish live model success.

The browser and interactive process share a single case and score; historical v4/v5 standalone packs remain readable only for old evidence. Compare source digests like-for-like.