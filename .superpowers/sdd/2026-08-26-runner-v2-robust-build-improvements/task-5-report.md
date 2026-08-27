# P5.6 implementation report — configured Runner capabilities

## Outcome

P5.6 is complete. Runner V2 now loads an explicit, strict capabilities
configuration before startup; creates one shared language-provider router for
each Build run; wires governed extension tools, bounded extension context, and
language intelligence through live Worker, Architect, and subagent runtimes;
and records capability/audit metadata in the Build observability snapshot.

## Implemented scope

- Added strict version-1 capabilities configuration parsing in
  `runner-capabilities-config.ts`.
  - The configuration path and every extension allowlist entry must be
    absolute.
  - The configuration must be a regular, non-symbolic JSON file and has exact
    top-level/server schemas, bounded collections and values, and no
    environment/secret field.
  - It supports configured stdio language servers with extension/root-marker
    routing metadata and bounded LSP limits.
- Added `LanguageProviderRouter`.
  - It selects extension, configured, or `builtin.typescript` providers by
    file extension, matching root marker, priority, and deterministic ID.
  - It lazily owns configured LSP instances per provider/workspace, records
    bounded route audit records, and closes configured processes in reverse
    startup order before the built-in provider.
- Added a per-run capability lifecycle in `NativeBuildFactory`.
  - It starts allowlisted extensions atomically, reserves all native and live
    MCP tool names before an extension can start, creates the shared router,
    and propagates the registry/router to Worker and Architect runtimes.
  - Setup failures close already-started language/extension resources; settled
    cleanup stops managed processes first, then closes language resources and
    extensions before workspace/database disposal.
- Wired live governed extension behavior.
  - Worker and Architect register extension tools through their existing
    `ToolBroker`; this preserves permission, budget, artifact, tool-ledger,
    and durable `extensionId` attribution controls.
  - Worker and Architect context use the existing `ContextAssembler` with
    existing extension-runtime contributor bounds. No extension receives a
    kernel store.
  - Subagents receive the same run-scoped router; existing `code.*` names and
    TypeScript fallback behavior remain unchanged.
- Added `capabilities` observability metadata: loaded extension manifests,
  provider metadata/source, and bounded language-route audit records.
- Added `--capabilities-config <absolute-path>` to the Runner CLI. It validates
  location and contents before state creation, Git/MCP setup, listening, or
  any model work; configurations inside the project are rejected.
- Added `docs/runner-v2/extensions.md`, including the JSON schema/example,
  capability trust boundary, context/tool governance, language routing,
  cleanup, and maintained Node 22/24 guidance.

## TDD evidence

The initial recorded live-runtime tests were run red before implementation:

- `worker runtime exposes extension tools through the governed live broker`
  initially executed zero extension calls.
- `Architect provider failure pauses for user-selected handoff before planning`
  initially had no extension tool/context wiring in the live Architect path.

Both are green in the final suite. Additional red/green guards covered:

- missing factory capability construction/registry propagation;
- failure cleanup after a language-provider identity collision following a
  successfully started extension;
- extension use of the built-in `fs.read` name before startup;
- unknown CLI `--capabilities-config` support and malformed configuration
  acceptance;
- a fault-injected in-project configuration containment bypass.

One test-fixture repair cycle was required: the intentional pre-start reserved
name failure invoked the fixture's close hook before it had a state directory.
The fixture close hook was made safe before start, the production guard was
restored, and the red/green test passed. No production authority or cleanup
guard was weakened.

## Tests and validation

- Focused P5.6 capability/router/plugin/runtime/factory/cleanup/CLI suite:
  49 passing tests.
- Final Windows CLI smoke:
  `runner-v2/test/cli-capabilities-config.test.ts` — 3/3 passing.
- `npm run typecheck:runner-v2` — passing.
- Targeted ESLint across every changed Runner source/test file — passing.
- `npm run test:runner-v2` — 709/709 tests passing, followed by all chained
  Runner client, policy, UI contract, live-state, transcript, files, stats,
  steering, and observability checks passing.
- `git diff --check` — clean.

The CLI smoke exercises external configuration from a Unicode temporary path,
invalid configuration rejection before Git/readiness/state creation, valid
readiness, and project-contained configuration rejection.

## Self-review

- Extension tools enter only through `ToolBroker.registerExtensionTool`; tool
  ledger, permission request, budget reservation, artifact label, and replay
  fingerprint retain `extensionId` attribution.
- Context contributors receive the existing bounded request and are assembled
  through `ContextAssembler`; only optional namespaced sections are added.
- The shared router is passed from the factory to Worker, Architect, and
  nested subagents. `builtin.typescript` remains present even with no optional
  configuration.
- Extension/tool and language-provider identity conflicts fail before a usable
  runtime is returned. Built-in names plus dynamic configured MCP names are
  reserved prior to extension startup.
- LSP processes are observed through a real configured non-TypeScript fixture
  and its shutdown marker, while full-suite process/cleanup tests remain
  green.
- No client-visible configuration surface was added, so a production web build
  was not required by the packet.

## Concerns

None. The prior temporary CLI fault-injection child process was explicitly
identified by its temporary test command line and terminated during cleanup;
the final captured full suite and all smoke tests completed with no residual
fixture-process failure.
