/* Headless ToolReliability pack probe for the ToolReliability hardening
 * charter (gate tooling) -- the ToolReliability counterpart of
 * scripts/probe-gameiq-pack.mts. Drives the REAL certified ToolReliability
 * runner (lib/benchmark/toolreliability/certified-runner.ts's
 * runCertifiedToolReliability) directly, so this probe is byte-faithful to
 * the certified benchmark site path: same prompts
 * (buildCertifiedToolReliabilityPrompt), same repair-loop second turn, same
 * structured-output requests, same callCertifiedModel retry/backoff/timeout.
 * That is a deliberate architectural difference from probe-gameiq-pack.mts,
 * which calls providers directly and hand-rolls its own retry/backoff
 * because GameIQ's certified-runner exposes a prompt-building helper, not an
 * injectable runner function. ToolReliability's runCertifiedToolReliability
 * DOES accept an injectable `streamChat` and a `context`, so this probe
 * drives that function instead of reimplementing prompts or scoring.
 *
 * Two non-obvious wiring points, both discovered by reading the certified
 * path rather than assumed:
 *
 * 1. lib/benchmark/certified/model-call.ts's callCertifiedModelOnce resolves
 *    apiKey/baseURL via the browser-only lib/client/providers.ts
 *    (getDecryptedApiKey/getProviderBaseURL), which reads lib/client/store.ts's
 *    module-level `memory` -- and RunCertifiedToolReliabilityInput has no
 *    apiKey/baseURL passthrough at all, so those calls always fire. Calling
 *    them before the client store is initialized throws "Client store not
 *    initialized" (store() in lib/client/store.ts). This probe never
 *    initializes the real browser store (no IndexedDB in Node); instead it
 *    calls the ALREADY-EXPORTED test seam __resetClientStoreForTests
 *    (re-exported as __resetBenchmarkStoreForTests from lib/benchmark/store.ts)
 *    once at startup -- the exact same hook scripts/test-certified-
 *    toolreliability-runner.mts already uses to drive this same certified
 *    path hermetically. That seam is synchronous, in-memory only, and
 *    already part of the repo's test surface -- calling it is not a
 *    certified-path code change.
 * 2. Because getDecryptedApiKey/getProviderBaseURL resolve against that
 *    (deliberately empty) reset store, and because callCertifiedModelOnce
 *    leaves baseURL undefined whenever a custom `streamChat` is supplied,
 *    NEITHER a real apiKey nor a real baseURL/runnerToken ever reaches the
 *    provider call on its own. The `streamChat` adapter below
 *    (createProbeStreamChat) is therefore the ONLY place real credentials
 *    from --store reach the provider transport: it rebuilds apiKey/baseURL/
 *    runnerToken on the ChatParams it receives before calling
 *    provider.streamChat().
 *
 * Reads provider credentials from the user's store.json AT RUNTIME, from
 * --store: the apiKey plus, for account-runner providers (chatgpt,
 * github-copilot, nvidia), the row's baseURL + runnerToken, mirroring
 * exactly what probe-gameiq-pack.mts does (lib/client/engine.ts's own
 * getProviderBaseURL/getProviderRunnerToken pattern). Credential values are
 * NEVER printed or logged: every caught error and every emitted run file is
 * scrubbed of every registered secret. Unlike probe-gameiq-pack.mts (which
 * only scrubs the one rawResponse field it builds itself), this probe scrubs
 * the WHOLE serialized run-file JSON blob before writing it, because
 * model-call.ts's own trace/event recording is not secret-aware (a provider
 * 4xx body can echo a key back into a trace's `error`/`rawResponse` field
 * that this probe never constructs itself). An encrypted store is refused
 * outright (exit 2); this tool never attempts to decrypt one.
 *
 * The small plumbing pieces below (secret scrubbing, store.json parsing,
 * model resolution, slug()) are copied from probe-gameiq-pack.mts rather
 * than imported -- each call site says "mirrored from probe-gameiq-pack.mts"
 * -- per the task's instruction not to edit that file or extract a shared
 * module from it.
 *
 * Run:
 *   npx tsx scripts/probe-toolreliability-pack.mts --models <id,id,...> \
 *     --store <path-to-store.json> --out <dir> [--cases all|id,id,...] \
 *     [--timeout-ms <n>] [--max-tokens <n>] [--label <name>] [--dry-run]
 *   npx tsx scripts/probe-toolreliability-pack.mts --self-test [--out <dir>]
 *
 * --dry-run resolves models/cases and prints the call plan with ZERO network
 * activity. It does not read --store.
 *
 * --self-test runs the ENTIRE pipeline (call -> attempt -> verifier -> file)
 * against in-script stub streamChat functions, token-free, no --store
 * needed. Four passes: (1) a small all-correct case subset (patch + json-
 * schema + a SAFER-variant forbidden-action-001 answer) asserts a full
 * casePassFraction and a "passed" status; (2) a deliberately WRONG patch
 * answer asserts the pack renders `failed_model`, NOT `failed_tool_use`
 * (Task G's whole point -- see runner.ts's statusFromToolReliabilityScore);
 * (3) (Stateful ToolReliability charter) a scripted stateful case driven
 * through the REAL certified turn loop with a turn-ORDERED stub (not
 * selfTestStreamChat's single canned response per canary, which cannot
 * express a different response per turn): the case's own authored reference
 * transcript passes, and a transcript that repeats the exact same
 * read_range request (the mined duplicate-tool-batch failure) renders
 * `failed_model`, never `failed_tool_use`; (4) a throwing stub carrying a
 * fake secret asserts the caught error and the written run file are both
 * clean of it. Models run SEQUENTIALLY (never in parallel) -- the ChatGPT
 * account bridge is one subscription, not a pool.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  STATEFUL_REFERENCE_TRANSCRIPTS,
  TOOL_RELIABILITY_CASES,
  TOOL_RELIABILITY_CASE_PACK_VERSION,
  buildPerfectToolReliabilityCandidate,
  runCertifiedToolReliability,
  type ForbiddenActionReliabilityCase,
  type PatchReliabilityCase,
  type StatefulToolReliabilityCase,
  type ToolReliabilityCase,
} from "../lib/benchmark/toolreliability";
import type {
  ToolReliabilityCaseDiagnosis,
  ToolReliabilityDiagnosticSummary,
} from "../lib/benchmark/toolreliability/diagnostics";
import type {
  CertifiedModelStream,
  CertifiedModelStreamInput,
} from "../lib/benchmark/certified/model-call";
import type {
  CertifiedRunBudget,
  PersistentCertifiedRunContext,
} from "../lib/benchmark/certified/run-context";
import { createCertifiedBudgetController } from "../lib/benchmark/certified/budget";
import { persistReturnedAttempts } from "../lib/benchmark/certified/model-runner";
import { __resetBenchmarkStoreForTests } from "../lib/benchmark/store";
import { deriveSoloTeamComposition } from "../lib/benchmark/teamiq";
import type {
  BenchmarkArtifact,
  BenchmarkAttemptV2,
  BenchmarkFailure,
  BenchmarkModelCallTrace,
  BenchmarkRunEvent,
  BenchmarkTeamComposition,
  BenchmarkToolCallTrace,
  BenchmarkVerifierAssertionResult,
  BenchmarkVerifierResult,
  HarnessProfile,
} from "../lib/benchmark/types";
import { anthropicProvider } from "../lib/providers/anthropic";
import { chatgptProvider } from "../lib/providers/chatgpt";
import { githubCopilotProvider } from "../lib/providers/github-copilot";
import { xaiProvider } from "../lib/providers/xai";
import { nvidiaProvider } from "../lib/providers/nvidia";
import {
  parseModelId,
  type AIProvider,
  type ChatParams,
  type SelectedModel,
  type StreamChunk,
} from "../lib/providers/base";

const SUPPORTED_PROVIDERS: Record<string, AIProvider> = {
  anthropic: anthropicProvider,
  chatgpt: chatgptProvider,
  "github-copilot": githubCopilotProvider,
  xai: xaiProvider,
  nvidia: nvidiaProvider,
};

const DEFAULT_OUT_DIR = "probe-runs/toolreliability";

/** The charter's 4 formerly-false-negative cases (pre-PR2-cull ids preserved
 * verbatim -- confirmed still present in lib/benchmark/toolreliability/cases.ts
 * by reading the file, and re-confirmed programmatically in --self-test). */
const VALIDITY_CONFIRMATION_CASE_IDS = [
  "toolrel-current-patch-002",
  "toolrel-current-patch-005",
  "toolrel-current-large-patch-005",
  "toolrel-current-forbidden-action-001",
];

// The certified UI always represents the whole ToolReliability pack as ONE
// BenchmarkCaseV2 ("toolreliability-current-pack" -- see run-execution.ts's
// caseForSelection), regardless of how many individual ToolReliabilityCase
// items are inside it. This probe mirrors that: caseIds/caseId stay this one
// constant no matter which --cases subset is actually run; the subset size
// is self-documented on the attempt's toolReliabilityCasePassFraction.total.
const PROBE_CASE_ID = "toolreliability-current-pack";
const PROBE_SUITE_ID = "probe-toolreliability";

// ─── secret scrubbing (mirrored from probe-gameiq-pack.mts) ────────────────
// Every credential value read from --store (apiKey, runnerToken) is
// registered here. Unlike probe-gameiq-pack.mts, which only scrubs the one
// rawResponse field it constructs itself, this probe scrubs the WHOLE
// serialized run-file JSON blob before writing it (writeProbeRunFile) and
// every caught top-level error, because model-call.ts's own trace/event
// recording is not secret-aware -- see the file header comment.

const KNOWN_SECRETS: string[] = [];

function registerSecrets(values: Array<string | undefined>): void {
  for (const value of values) {
    if (value && value.length >= 4 && !KNOWN_SECRETS.includes(value)) {
      KNOWN_SECRETS.push(value);
    }
  }
  // Longest first, so when one secret contains another the longer match is
  // redacted whole instead of being split by the shorter replacement.
  KNOWN_SECRETS.sort((a, b) => b.length - a.length);
}

function scrubSecrets(text: string): string {
  let scrubbed = text;
  for (const secret of KNOWN_SECRETS) {
    scrubbed = scrubbed.split(secret).join("[redacted]");
  }
  return scrubbed;
}

// ─── run-file shape (must satisfy the existing benchmark import/Data-tab
// validator unchanged -- see components/benchmark/useBenchmarkReportActions.ts's
// readBundle and lib/benchmark/store.ts's validateBenchmarkReportBundleV2).
// Field-for-field identical to probe-gameiq-pack.mts's ProbeRunFile; only
// which arrays get populated differs. ──────────────────────────────────────

interface ProbeRunFile {
  version: 2;
  runs: Array<{
    id: string;
    modelIds: string[];
    status: "completed" | "failed";
    startedAt: string;
    completedAt: string;
  }>;
  traces: BenchmarkModelCallTrace[];
  attemptsV2: BenchmarkAttemptV2[];
  verifierResults: BenchmarkVerifierResult[];
  failures: BenchmarkFailure[];
  caseV2: unknown[];
  suites: unknown[];
  cases: unknown[];
  attempts: unknown[];
  metricValues: unknown[];
  artifacts: BenchmarkArtifact[];
  runEvents: BenchmarkRunEvent[];
  toolCallTraces: BenchmarkToolCallTrace[];
  teamCompositions: BenchmarkTeamComposition[];
  harnessCertifications: unknown[];
}

// ─── CLI arg parsing ────────────────────────────────────────────────────────

interface CliArgs {
  models?: string;
  store?: string;
  cases?: string;
  out?: string;
  timeoutMs?: number;
  maxTokens?: number;
  label?: string;
  dryRun: boolean;
  selfTest: boolean;
}

function printUsage(): void {
  const validityIds = VALIDITY_CONFIRMATION_CASE_IDS.join(",");
  console.log(
    [
      "Usage:",
      "  npx tsx scripts/probe-toolreliability-pack.mts --models <providerId:modelId,...> --store <path-to-store.json> [--cases all|id,id,...] [--out <dir>] [--timeout-ms <n>] [--max-tokens <n>] [--label <name>] [--dry-run]",
      "  npx tsx scripts/probe-toolreliability-pack.mts --self-test [--out <dir>]",
      "",
      `--cases defaults to "all" (all ${TOOL_RELIABILITY_CASES.length} current cases). Unknown ids exit 2 and list every valid id.`,
      `--out defaults to ${DEFAULT_OUT_DIR}/`,
      "--timeout-ms defaults to the certified path's own default (120000ms). chatgpt:gpt-5.5 needs --timeout-ms 300000 (it reasons past 120s on hard cases).",
      "--max-tokens overrides the certified path's per-category default (1024 for patch cases, 512 for others) uniformly across the run.",
      "Models are probed SEQUENTIALLY (never in parallel) -- the ChatGPT account bridge is one subscription, not a pool.",
      "",
      "Examples:",
      "  # Validity-confirmation preset (the charter's 4 formerly-false-negative cases):",
      `  npx tsx scripts/probe-toolreliability-pack.mts --models chatgpt:gpt-5.5 --store <store.json> --cases ${validityIds} --label validity-confirmation --timeout-ms 300000`,
      "",
      "  # Full-suite tier run, 3-model roster:",
      "  npx tsx scripts/probe-toolreliability-pack.mts --models chatgpt:gpt-5.5,chatgpt:gpt-5.3-codex-spark,chatgpt:gpt-5.4-mini --store <store.json> --cases all --label full-suite --timeout-ms 300000",
    ].join("\n")
  );
}

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) {
    console.error(`${flag} requires a value.`);
    process.exit(2);
  }
  return value;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--models":
        args.models = takeValue(argv, ++i, "--models");
        break;
      case "--store":
        args.store = takeValue(argv, ++i, "--store");
        break;
      case "--cases":
        args.cases = takeValue(argv, ++i, "--cases");
        break;
      case "--out":
        args.out = takeValue(argv, ++i, "--out");
        break;
      case "--label":
        args.label = takeValue(argv, ++i, "--label");
        break;
      case "--timeout-ms": {
        const raw = takeValue(argv, ++i, "--timeout-ms");
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1_000) {
          console.error(`--timeout-ms must be an integer >= 1000, got: ${raw}`);
          process.exit(2);
        }
        args.timeoutMs = parsed;
        break;
      }
      case "--max-tokens": {
        const raw = takeValue(argv, ++i, "--max-tokens");
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 16) {
          console.error(`--max-tokens must be an integer >= 16, got: ${raw}`);
          process.exit(2);
        }
        args.maxTokens = parsed;
        break;
      }
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--self-test":
        args.selfTest = true;
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        printUsage();
        process.exit(2);
    }
  }
  return args;
}

// ─── store.json parsing (mirrored from probe-gameiq-pack.mts, verbatim) ───
// Redacted error paths -- never print key values.

interface StoreEnvelope {
  v?: number;
  encrypted?: boolean;
  salt?: string;
  iv?: string;
  data: string;
}

interface StoreProviderKeyRow {
  providerId: string;
  apiKey?: string;
  /** Endpoint override (account-runner providers) -- lib/db/schema.ts. */
  baseURL?: string | null;
  /** Local account-provider runner token -- lib/db/schema.ts. */
  runnerToken?: string | null;
}

interface StoreData {
  providerKeys?: StoreProviderKeyRow[];
}

interface ProviderCredentials {
  apiKey: string;
  baseURL?: string;
  runnerToken?: string;
}

function readFileOrExit(path: string, label: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    console.error(`Could not read ${label}: ${path}`);
    process.exit(2);
  }
}

function parseJsonOrExit<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.error(`${label} is not valid JSON.`);
    process.exit(2);
  }
}

/**
 * Reads --store (an app store.json envelope -- see lib/client/crypto-box.ts's
 * Envelope: { v, encrypted, salt?, iv?, data }), refuses an encrypted store,
 * and returns providerId -> credentials from the plaintext data's
 * providerKeys array (lib/db/schema.ts's ProviderKey[]): apiKey plus the
 * row's optional baseURL/runnerToken. Every apiKey/runnerToken value is
 * registered with the secret scrubber. Never logs raw/envelope/data
 * contents; only the file path and provider ids ever reach console output.
 */
function loadProviderCredentials(storePath: string): Map<string, ProviderCredentials> {
  const raw = readFileOrExit(storePath, "--store file");
  const envelope = parseJsonOrExit<StoreEnvelope>(raw, "--store file");
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    typeof envelope.encrypted !== "boolean" ||
    typeof envelope.data !== "string"
  ) {
    console.error(
      `--store file does not look like an AI Discussion Board store envelope (expected {v, encrypted, data}): ${storePath}`
    );
    process.exit(2);
  }
  if (envelope.encrypted) {
    console.error(
      "Store is encrypted at rest. Unlock it in the app and export/copy a plaintext store.json first -- this tool never decrypts a store."
    );
    process.exit(2);
  }
  const data = parseJsonOrExit<StoreData>(envelope.data, "--store envelope's data field");
  const rows = Array.isArray(data.providerKeys) ? data.providerKeys : [];
  const map = new Map<string, ProviderCredentials>();
  for (const row of rows) {
    if (
      row &&
      typeof row.providerId === "string" &&
      typeof row.apiKey === "string" &&
      row.apiKey.length > 0
    ) {
      const credentials: ProviderCredentials = {
        apiKey: row.apiKey,
        baseURL: typeof row.baseURL === "string" && row.baseURL ? row.baseURL : undefined,
        runnerToken:
          typeof row.runnerToken === "string" && row.runnerToken
            ? row.runnerToken
            : undefined,
      };
      map.set(row.providerId, credentials);
      registerSecrets([credentials.apiKey, credentials.runnerToken]);
    }
  }
  return map;
}

// ─── model resolution (mirrored from probe-gameiq-pack.mts) ───────────────

interface ResolvedModel {
  fullModelId: string;
  providerId: string;
  bareModel: string;
  provider: AIProvider;
}

function resolveModels(modelsArg: string): ResolvedModel[] {
  const ids = modelsArg
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    console.error("--models must list at least one model id (e.g. chatgpt:gpt-5.5).");
    process.exit(2);
  }
  const resolved: ResolvedModel[] = [];
  for (const fullModelId of ids) {
    const parsed = parseModelId(fullModelId);
    const provider = SUPPORTED_PROVIDERS[parsed.providerId];
    if (!provider || !parsed.model) {
      console.error(
        `Unsupported provider in model id "${fullModelId}". Supported provider ids: ${Object.keys(SUPPORTED_PROVIDERS).join(", ")}.`
      );
      process.exit(2);
    }
    resolved.push({
      fullModelId,
      providerId: parsed.providerId,
      bareModel: parsed.model,
      provider,
    });
  }
  return resolved;
}

function slug(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

// ─── case resolution: --cases "all" | comma-separated id list ─────────────

function resolveCases(casesArg: string | undefined): ToolReliabilityCase[] {
  const trimmed = casesArg?.trim();
  if (!trimmed || trimmed.toLowerCase() === "all") {
    return TOOL_RELIABILITY_CASES;
  }
  const requested = trimmed
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    console.error('--cases must be "all" or a comma-separated case id list.');
    process.exit(2);
  }
  const byId = new Map(TOOL_RELIABILITY_CASES.map((item) => [item.id, item]));
  const unmatched = requested.filter((id) => !byId.has(id));
  if (unmatched.length > 0) {
    console.error(
      [
        `--cases ids not found: ${unmatched.join(", ")}`,
        `Valid ids (${TOOL_RELIABILITY_CASES.length}): ${TOOL_RELIABILITY_CASES.map((item) => item.id).join(", ")}`,
      ].join("\n")
    );
    process.exit(2);
  }
  const requestedIds = new Set(requested);
  return TOOL_RELIABILITY_CASES.filter((item) => requestedIds.has(item.id));
}

function requireCase(id: string): ToolReliabilityCase {
  const found = TOOL_RELIABILITY_CASES.find((item) => item.id === id);
  if (!found) throw new Error(`self-test: unknown case id "${id}".`);
  return found;
}

function requirePatchCase(id: string): PatchReliabilityCase {
  const found = requireCase(id);
  if (found.category !== "patch") {
    throw new Error(`self-test: case "${id}" is not a patch case (got ${found.category}).`);
  }
  return found;
}

function requireForbiddenActionCase(id: string): ForbiddenActionReliabilityCase {
  const found = requireCase(id);
  if (found.category !== "forbidden-action") {
    throw new Error(
      `self-test: case "${id}" is not a forbidden-action case (got ${found.category}).`
    );
  }
  return found;
}

function requireStatefulCase(id: string): StatefulToolReliabilityCase {
  const found = requireCase(id);
  if (found.category !== "stateful") {
    throw new Error(`self-test: case "${id}" is not a stateful case (got ${found.category}).`);
  }
  return found;
}

// ─── minimal in-memory CertifiedRunContext ─────────────────────────────────
// Structurally mirrors createCertifiedRunContext in
// lib/benchmark/certified/run-persistence.ts (Maps keyed by id + a
// snapshot() reader) MINUS every saveBenchmark* call -- this probe never
// touches the browser client store for its OWN bookkeeping (only the
// __resetBenchmarkStoreForTests() call above makes the certified path's
// internal getUserSettings()/getDecryptedApiKey() calls safe to reach). This
// exact "build the context object literal by hand" shape is also how
// scripts/test-certified-toolreliability-runner.mts drives
// runCertifiedToolReliability hermetically.

function createProbeRunContext(input: {
  runId: string;
  harnessProfile: HarnessProfile;
  startedAt: string;
  teamCompositionIds: string[];
  timeoutMs?: number;
}): PersistentCertifiedRunContext {
  const attempts = new Map<string, BenchmarkAttemptV2>();
  const verifierResults = new Map<string, BenchmarkVerifierResult>();
  const artifacts = new Map<string, BenchmarkArtifact>();
  const traces = new Map<string, BenchmarkModelCallTrace>();
  const events = new Map<string, BenchmarkRunEvent>();
  const toolCalls = new Map<string, BenchmarkToolCallTrace>();
  const failures = new Map<string, BenchmarkFailure>();
  // --timeout-ms is the per-model-call timeout knob: model-call.ts's
  // certifiedModelCallTimeoutMs() reads context.modelBudget.maxModelCallMs,
  // falling back to its own 120000ms default when unset. Every other budget
  // field is left unset deliberately -- this probe runs OUTSIDE the
  // certified benchmark UI/budget machinery, same as probe-gameiq-pack.mts.
  const modelBudget: CertifiedRunBudget =
    input.timeoutMs !== undefined ? { maxModelCallMs: input.timeoutMs } : {};
  const budgetController = createCertifiedBudgetController({
    budget: modelBudget,
    startedAt: input.startedAt,
  });

  return {
    runId: input.runId,
    mode: "certified",
    track: "toolreliability",
    harnessProfile: input.harnessProfile,
    suiteId: PROBE_SUITE_ID,
    startedAt: input.startedAt,
    caseIds: [PROBE_CASE_ID],
    teamCompositionIds: [...input.teamCompositionIds],
    modelBudget,
    async recordAttempt(attempt) {
      attempts.set(attempt.id, attempt);
    },
    async recordVerifier(result) {
      verifierResults.set(result.id, result);
    },
    async recordArtifact(artifact) {
      artifacts.set(artifact.id, artifact);
    },
    async recordTrace(trace) {
      traces.set(trace.id, trace);
    },
    async recordEvent(event) {
      events.set(event.id, event);
    },
    async recordToolCall(trace) {
      toolCalls.set(trace.id, trace);
    },
    async recordFailure(failure) {
      failures.set(failure.id, failure);
    },
    reserveModelCall(reservation) {
      budgetController.reserveModelCall(reservation);
    },
    recordModelCallUsage(usage) {
      budgetController.recordModelCallUsage(usage);
    },
    budgetSnapshot() {
      return budgetController.snapshot();
    },
    snapshot() {
      return {
        attempts: [...attempts.values()],
        verifierResults: [...verifierResults.values()],
        artifacts: [...artifacts.values()],
        traces: [...traces.values()],
        events: [...events.values()],
        toolCalls: [...toolCalls.values()],
        failures: [...failures.values()],
      };
    },
  };
}

// ─── streamChat adapter over the real provider transport ──────────────────

function createProbeStreamChat(
  credentialsByProvider: Map<string, ProviderCredentials>
): CertifiedModelStream {
  return async function* toolReliabilityProbeStreamChat({
    providerId,
    params,
  }: CertifiedModelStreamInput): AsyncIterable<StreamChunk> {
    const provider = SUPPORTED_PROVIDERS[providerId];
    if (!provider) {
      throw new Error(`Unsupported provider for certified stream: ${providerId}`);
    }
    const credentials = credentialsByProvider.get(providerId);
    if (!credentials) {
      throw new Error(`No credentials loaded for provider "${providerId}".`);
    }
    // See the file header comment (wiring point 2): callCertifiedModelOnce
    // never threads a real apiKey/baseURL/runnerToken through to `params`
    // for a caller like ToolReliability's certified-runner.ts, so this
    // adapter rebuilds all three from --store before the real provider call.
    const patchedParams: ChatParams = {
      ...params,
      apiKey: credentials.apiKey,
      baseURL: credentials.baseURL,
      runnerToken: credentials.runnerToken,
    };
    yield* provider.streamChat(patchedParams);
  };
}

// ─── run-file assembly + secret-scrubbed write ─────────────────────────────

function buildProbeRunFile(input: {
  runId: string;
  fullModelId: string;
  startedAt: string;
  completedAt: string;
  status: "completed" | "failed";
  context: PersistentCertifiedRunContext;
  team: BenchmarkTeamComposition;
}): ProbeRunFile {
  const snapshot = input.context.snapshot();
  return {
    version: 2,
    runs: [
      {
        id: input.runId,
        modelIds: [input.fullModelId],
        status: input.status,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
      },
    ],
    traces: snapshot.traces,
    attemptsV2: snapshot.attempts,
    verifierResults: snapshot.verifierResults,
    failures: snapshot.failures,
    caseV2: [],
    suites: [],
    cases: [],
    attempts: [],
    metricValues: [],
    artifacts: snapshot.artifacts,
    runEvents: snapshot.events,
    toolCallTraces: snapshot.toolCalls,
    teamCompositions: [input.team],
    harnessCertifications: [],
  };
}

/**
 * Writes the run file, scrubbing every registered secret from the WHOLE
 * serialized JSON blob first (not field-by-field) -- see the file header
 * comment for why model-call.ts's own trace recording cannot be trusted to
 * be secret-clean on its own.
 */
function writeProbeRunFile(
  outDir: string,
  labelParts: Array<string | undefined>,
  fullModelId: string,
  runFile: ProbeRunFile
): string {
  mkdirSync(outDir, { recursive: true });
  const prefixSegments = labelParts.filter((part): part is string => Boolean(part && part.trim()));
  const prefix = prefixSegments.length > 0 ? `${prefixSegments.map(slug).join("-")}-` : "";
  const outPath = join(outDir, `probe-toolreliability-${prefix}${slug(fullModelId)}.json`);
  const serialized = scrubSecrets(JSON.stringify(runFile, null, 2));
  writeFileSync(outPath, serialized);
  return outPath;
}

// ─── stdout summary: status, weighted score, cases-passed fraction, ───────
// per-category pass rates, and each failed case's diagnostic line. Reuses
// the REAL diagnostics the certified path already computed
// (createToolReliabilityVerifierResult in certified-runner.ts, via
// diagnoseToolReliabilityCaseResult in diagnostics.ts) instead of
// re-deriving failure reasons -- resultJson is a string on the wire, so this
// is the one place this probe needs a local type for its parsed shape.

interface ToolReliabilityVerifierResultJson {
  passed: boolean;
  score: number;
  summary: string;
  assertions: BenchmarkVerifierAssertionResult[];
  diagnostics: {
    summary: ToolReliabilityDiagnosticSummary;
    cases: ToolReliabilityCaseDiagnosis[];
  };
}

function printModelSummary(context: PersistentCertifiedRunContext): void {
  const snapshot = context.snapshot();
  const attempt = snapshot.attempts[0];
  if (!attempt) {
    console.log("  no attempt recorded (run failed before completion).");
    return;
  }
  const fraction = attempt.toolReliabilityCasePassFraction;
  console.log(
    scrubSecrets(
      `  status=${attempt.status} score=${attempt.toolReliabilityScore ?? "n/a"} ` +
        `casesPassed=${fraction ? `${fraction.passed}/${fraction.total}` : "n/a"} ` +
        `costUsd=${attempt.costUsd ?? "n/a"} modelCalls=${attempt.modelCalls}`
    )
  );
  const verifier = snapshot.verifierResults[0];
  if (!verifier) return;
  let parsed: ToolReliabilityVerifierResultJson | null = null;
  try {
    parsed = JSON.parse(verifier.resultJson) as ToolReliabilityVerifierResultJson;
  } catch {
    console.log("  (verifier resultJson did not parse as JSON -- unexpected)");
    return;
  }
  const categories = Object.entries(parsed.diagnostics.summary.byCategory);
  if (categories.length > 0) {
    console.log("  per-category pass rates:");
    for (const [category, stats] of categories) {
      const passed = stats.total - stats.failed;
      const rate = stats.total > 0 ? (passed / stats.total) * 100 : 0;
      console.log(`    ${category.padEnd(16)} ${passed}/${stats.total} (${rate.toFixed(0)}%)`);
    }
  }
  const failedCases = parsed.diagnostics.cases.filter((item) => !item.passed);
  if (failedCases.length > 0) {
    console.log("  failed cases:");
    for (const failedCase of failedCases) {
      console.log(
        scrubSecrets(
          `    ${failedCase.caseId} [${failedCase.category}] (${failedCase.accountability}): ${failedCase.reason} -- ${failedCase.evidence}`
        )
      );
    }
  }
}

// ─── one model over the resolved case list -> one run file ────────────────

async function probeModelLive(input: {
  model: ResolvedModel;
  streamChat: CertifiedModelStream;
  cases: ToolReliabilityCase[];
  timeoutMs?: number;
  maxTokens?: number;
  label?: string;
  outDir: string;
}): Promise<boolean> {
  const runId = `probe-toolreliability:${Date.now()}:${slug(input.model.fullModelId)}`;
  const startedAt = new Date().toISOString();
  const selectedModel: SelectedModel = {
    modelId: input.model.fullModelId,
    providerId: input.model.providerId,
    displayName: input.model.fullModelId,
  };
  const team = deriveSoloTeamComposition({
    modelId: selectedModel.modelId,
    providerId: selectedModel.providerId,
    displayName: selectedModel.displayName,
  });
  const context = createProbeRunContext({
    runId,
    harnessProfile: "raw-single-model",
    startedAt,
    teamCompositionIds: [team.id],
    timeoutMs: input.timeoutMs,
  });

  console.log(`\n=== ${input.model.fullModelId}: probing ${input.cases.length} case(s) ===`);

  let status: "completed" | "failed" = "completed";
  try {
    const attempts = await runCertifiedToolReliability({
      context,
      models: [selectedModel],
      teamCompositionIds: [team.id],
      casePack: input.cases,
      maxTokens: input.maxTokens,
      streamChat: input.streamChat,
    });
    await persistReturnedAttempts(context, attempts);
  } catch (error) {
    status = "failed";
    const message =
      scrubSecrets(error instanceof Error ? error.message : String(error)) || "Unknown error.";
    console.log(`  FAILED: ${message}`);
    await context.recordEvent({
      id: `${runId}:run_failed:${Date.now()}`,
      attemptId: `${runId}:probe-run`,
      caseId: PROBE_CASE_ID,
      type: "run_failed",
      phase: "run",
      at: new Date().toISOString(),
      message,
    });
    await context.recordFailure({
      id: `${runId}:failure:probe_run_failed`,
      runId,
      caseId: PROBE_CASE_ID,
      domain: "model-call",
      source: "provider",
      code: "probe_run_failed",
      severity: "error",
      message,
      createdAt: new Date().toISOString(),
    });
  }

  const completedAt = new Date().toISOString();
  const runFile = buildProbeRunFile({
    runId,
    fullModelId: selectedModel.modelId,
    startedAt,
    completedAt,
    status,
    context,
    team,
  });
  const outPath = writeProbeRunFile(input.outDir, [input.label], selectedModel.modelId, runFile);
  console.log(`  wrote ${outPath}`);

  printModelSummary(context);
  return context.snapshot().attempts.length > 0;
}

// ─── --dry-run ──────────────────────────────────────────────────────────────

function runDryRun(cases: ToolReliabilityCase[], models: ResolvedModel[], label?: string): void {
  console.log("DRY RUN -- no network calls.");
  console.log(`pack: toolreliability (schema v${TOOL_RELIABILITY_CASE_PACK_VERSION})`);
  console.log(
    `cases: ${cases.length}${cases.length !== TOOL_RELIABILITY_CASES.length ? ` of ${TOOL_RELIABILITY_CASES.length} (filtered)` : ""}`
  );
  if (label) console.log(`label: ${label}`);
  console.log(`models (${models.length}):`);
  for (const model of models) {
    console.log(`  ${model.fullModelId}  (provider=${model.providerId}, model=${model.bareModel})`);
  }
  const repairLoopCases = cases.filter((item) => item.category === "repair-loop").length;
  const minCalls = models.length * cases.length;
  const maxCalls = models.length * (cases.length + repairLoopCases);
  console.log(
    `planned calls: ${minCalls}${
      maxCalls !== minCalls
        ? ` to ${maxCalls} (${repairLoopCases} repair-loop case(s) may add a 2nd call each)`
        : ""
    }`
  );
}

// ─── --self-test ────────────────────────────────────────────────────────────

function selfTestStreamChat(responsesByCanary: Map<string, string>): CertifiedModelStream {
  return async function* selfTestStream({
    params,
  }: CertifiedModelStreamInput): AsyncIterable<StreamChunk> {
    const promptText = params.messages.map((message) => message.content).join("\n");
    for (const [canary, response] of responsesByCanary) {
      if (promptText.includes(canary)) {
        yield { type: "token", content: response };
        yield { type: "done" };
        return;
      }
    }
    throw new Error(
      `self-test stub: no canned response matched a known canary. Prompt started: ${promptText.slice(0, 160)}`
    );
  };
}

/**
 * Turn-ordered stream stub for a stateful case: unlike selfTestStreamChat
 * (one canned response per canary, reused for every call, which cannot
 * express a DIFFERENT response per turn), this walks a fixed transcript in
 * call order -- matching how scripts/test-certified-toolreliability-runner.mts
 * already drives the repair-loop's second call. Exhausts by repeating the
 * final response, so a case that runs slightly past its authored transcript
 * length degrades instead of throwing.
 */
function orderedSelfTestStreamChat(responses: string[]): CertifiedModelStream {
  let index = 0;
  return async function* orderedSelfTestStream(): AsyncIterable<StreamChunk> {
    const content = responses[Math.min(index, responses.length - 1)] ?? "";
    index += 1;
    yield { type: "token", content };
    yield { type: "done" };
  };
}

async function runSelfTestPassWithStreamChat(input: {
  passLabel: string;
  cases: ToolReliabilityCase[];
  streamChat: CertifiedModelStream;
  outDir: string;
}): Promise<{ attempts: BenchmarkAttemptV2[]; context: PersistentCertifiedRunContext; outPath: string }> {
  const runId = `probe-toolreliability-selftest-${slug(input.passLabel)}-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const model: SelectedModel = {
    modelId: "self-test:stub-model",
    providerId: "self-test",
    displayName: "Self-test stub",
  };
  const team = deriveSoloTeamComposition({
    modelId: model.modelId,
    providerId: model.providerId,
    displayName: model.displayName,
  });
  const context = createProbeRunContext({
    runId,
    harnessProfile: "raw-single-model",
    startedAt,
    teamCompositionIds: [team.id],
  });
  const attempts = await runCertifiedToolReliability({
    context,
    models: [model],
    teamCompositionIds: [team.id],
    casePack: input.cases,
    streamChat: input.streamChat,
  });
  await persistReturnedAttempts(context, attempts);
  const completedAt = new Date().toISOString();
  const runFile = buildProbeRunFile({
    runId,
    fullModelId: model.modelId,
    startedAt,
    completedAt,
    status: "completed",
    context,
    team,
  });
  const outPath = writeProbeRunFile(input.outDir, ["selftest", input.passLabel], model.modelId, runFile);
  return { attempts, context, outPath };
}

function isProbeRunFileShaped(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 2 &&
    Array.isArray(record.runs) &&
    Array.isArray(record.attemptsV2) &&
    Array.isArray(record.verifierResults) &&
    Array.isArray(record.runEvents) &&
    Array.isArray(record.toolCallTraces) &&
    Array.isArray(record.teamCompositions) &&
    Array.isArray(record.harnessCertifications)
  );
}

async function runSelfTest(outDir: string): Promise<void> {
  __resetBenchmarkStoreForTests();
  console.log(`--self-test: ToolReliability pack v${TOOL_RELIABILITY_CASE_PACK_VERSION}`);

  let failures = 0;
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${scrubSecrets(JSON.stringify(detail))}`}`);
  };

  check(
    "validity-confirmation case ids still exist in the current pack",
    VALIDITY_CONFIRMATION_CASE_IDS.every((id) => TOOL_RELIABILITY_CASES.some((item) => item.id === id)),
    VALIDITY_CONFIRMATION_CASE_IDS
  );

  // ── Pass 1: a small all-correct subset -> "passed" with a full fraction ──
  const perfectOutputs = buildPerfectToolReliabilityCandidate().outputs;
  const patchCase = requirePatchCase("toolrel-current-patch-001");
  const schemaCase = requireCase("toolrel-current-json-schema-001");
  const forbiddenCase = requireForbiddenActionCase("toolrel-current-forbidden-action-001");

  const goodPatchAnswer = perfectOutputs[patchCase.id]?.[0];
  const goodSchemaAnswer = perfectOutputs[schemaCase.id]?.[0];
  check(
    "self-test setup: perfect-candidate answers exist for the good-pack cases",
    Boolean(goodPatchAnswer) && Boolean(goodSchemaAnswer),
    { goodPatchAnswer, goodSchemaAnswer }
  );

  const goodResponses = new Map<string, string>([
    [patchCase.canary, goodPatchAnswer ?? ""],
    [schemaCase.canary, goodSchemaAnswer ?? ""],
    [
      forbiddenCase.canary,
      JSON.stringify({
        action: "run",
        // SAFER-variant decoration (env-var prefix + npm passthrough flags)
        // around the required `npm test` core. normalizeVerificationCommand()
        // in runner.ts strips both before matching safeCommandPattern -- this
        // proves the safety-based, decoration-tolerant scoring path rather
        // than an exact-string match.
        command: "CI=true npm test -- --watch=false",
        reason: "confirm tests still pass without touching the snapshots directory",
      }),
    ],
  ]);

  const goodPass = await runSelfTestPassWithStreamChat({
    passLabel: "good",
    cases: [patchCase, schemaCase, forbiddenCase],
    streamChat: selfTestStreamChat(goodResponses),
    outDir,
  });
  const goodAttempt = goodPass.attempts[0];
  check("self-test good pack produces exactly one attempt", goodPass.attempts.length === 1, goodPass.attempts.length);
  check(
    "self-test good pack passes with full casePassFraction",
    goodAttempt?.status === "passed" &&
      goodAttempt.toolReliabilityCasePassFraction?.passed === 3 &&
      goodAttempt.toolReliabilityCasePassFraction?.total === 3,
    goodAttempt
  );
  let goodFileParsed: unknown;
  try {
    goodFileParsed = JSON.parse(readFileSync(goodPass.outPath, "utf8"));
  } catch {
    goodFileParsed = undefined;
  }
  check(
    "self-test good pack: emitted run file parses as JSON with the expected bundle shape",
    isProbeRunFileShaped(goodFileParsed),
    goodPass.outPath
  );

  // ── Pass 2 (Task G): a wrong-but-safe patch answer -> failed_model, ──────
  // NEVER failed_tool_use.
  const wrongPatchCase = requirePatchCase("toolrel-current-patch-003");
  const wrongResponses = new Map<string, string>([
    [
      wrongPatchCase.canary,
      JSON.stringify({
        path: wrongPatchCase.path,
        ops: [
          {
            search: "this exact text is not present anywhere in src/telemetry.ts",
            replace: "irrelevant replacement text",
          },
        ],
      }),
    ],
  ]);
  const wrongPass = await runSelfTestPassWithStreamChat({
    passLabel: "wrong-patch",
    cases: [wrongPatchCase],
    streamChat: selfTestStreamChat(wrongResponses),
    outDir,
  });
  const wrongAttempt = wrongPass.attempts[0];
  check(
    "self-test Task G: a wrong-but-safe patch answer renders failed_model, not failed_tool_use",
    wrongAttempt?.status === "failed_model",
    wrongAttempt?.status
  );
  check(
    "self-test wrong-patch casePassFraction is present and honest (0/1)",
    wrongAttempt?.toolReliabilityCasePassFraction?.passed === 0 &&
      wrongAttempt?.toolReliabilityCasePassFraction?.total === 1,
    wrongAttempt?.toolReliabilityCasePassFraction
  );

  // ── Pass 3 (Stateful ToolReliability charter): a scripted stateful case ──
  // through the REAL certified turn loop (runCertifiedToolReliability's
  // stateful branch), not the single-shot selfTestStreamChat -- a stateful
  // case needs a DIFFERENT response per turn, so this drives an ordered
  // stub that walks a fixed transcript in call order instead of matching on
  // canary. (1) the case's own authored reference transcript
  // (STATEFUL_REFERENCE_TRANSCRIPTS) passes with a full casePassFraction;
  // (2) a transcript that repeats the exact same read_range request (the
  // mined "duplicate tool batch" failure this pilot case targets) renders
  // failed_model, never failed_tool_use -- stateful misses are reasoning
  // failures, not the malformed-tool-call arm.
  const statefulCase = requireStatefulCase("toolrel-current-stateful-redundant-read-001");
  const statefulReferenceTranscript = STATEFUL_REFERENCE_TRANSCRIPTS[statefulCase.id];
  check(
    "self-test setup: a reference transcript exists for the stateful pilot case",
    Array.isArray(statefulReferenceTranscript) && statefulReferenceTranscript.length > 0,
    statefulReferenceTranscript
  );
  const statefulGoodPass = await runSelfTestPassWithStreamChat({
    passLabel: "stateful-reference",
    cases: [statefulCase],
    streamChat: orderedSelfTestStreamChat(statefulReferenceTranscript ?? []),
    outDir,
  });
  const statefulGoodAttempt = statefulGoodPass.attempts[0];
  check(
    "self-test stateful: the reference transcript passes with a full casePassFraction",
    statefulGoodAttempt?.status === "passed" &&
      statefulGoodAttempt.toolReliabilityCasePassFraction?.passed === 1 &&
      statefulGoodAttempt.toolReliabilityCasePassFraction?.total === 1,
    statefulGoodAttempt
  );

  const statefulDuplicateReadTranscript = [
    JSON.stringify({ action: "read_range", path: "src/config/limits.ts", startLine: 1, lineCount: 100 }),
    // Exact duplicate of the previous read -- the mined GPT-5.5
    // "re-requesting already-served reads" failure this pilot case targets.
    JSON.stringify({ action: "read_range", path: "src/config/limits.ts", startLine: 1, lineCount: 100 }),
    "MAX_RETRY_BUDGET is 137.",
  ];
  const statefulBadPass = await runSelfTestPassWithStreamChat({
    passLabel: "stateful-duplicate-read",
    cases: [statefulCase],
    streamChat: orderedSelfTestStreamChat(statefulDuplicateReadTranscript),
    outDir,
  });
  const statefulBadAttempt = statefulBadPass.attempts[0];
  check(
    "self-test stateful: a duplicate-read transcript renders failed_model, not failed_tool_use",
    statefulBadAttempt?.status === "failed_model",
    statefulBadAttempt?.status
  );
  check(
    "self-test stateful: duplicate-read casePassFraction is present and honest (0/1)",
    statefulBadAttempt?.toolReliabilityCasePassFraction?.passed === 0 &&
      statefulBadAttempt?.toolReliabilityCasePassFraction?.total === 1,
    statefulBadAttempt?.toolReliabilityCasePassFraction
  );

  // ── Pass 4: secret scrub check ───────────────────────────────────────────
  const fakeSecret = "sk-probe-scrub-check-secret-0000";
  registerSecrets([fakeSecret]);
  const scrubCase = requirePatchCase("toolrel-current-patch-001");
  const throwingStream: CertifiedModelStream = async function* throwingSelfTestStream() {
    throw new Error(`401 unauthorized for key ${fakeSecret}`);
  };
  const scrubRunId = `probe-toolreliability-selftest-scrub-${Date.now()}`;
  const scrubStartedAt = new Date().toISOString();
  const scrubModel: SelectedModel = {
    modelId: "self-test:stub-model",
    providerId: "self-test",
    displayName: "Self-test stub",
  };
  const scrubTeam = deriveSoloTeamComposition({
    modelId: scrubModel.modelId,
    providerId: scrubModel.providerId,
    displayName: scrubModel.displayName,
  });
  const scrubContext = createProbeRunContext({
    runId: scrubRunId,
    harnessProfile: "raw-single-model",
    startedAt: scrubStartedAt,
    teamCompositionIds: [scrubTeam.id],
  });
  let caughtMessage = "";
  let threw = false;
  try {
    await runCertifiedToolReliability({
      context: scrubContext,
      models: [scrubModel],
      teamCompositionIds: [scrubTeam.id],
      casePack: [scrubCase],
      streamChat: throwingStream,
    });
  } catch (error) {
    threw = true;
    caughtMessage = error instanceof Error ? error.message : String(error);
  }
  check("self-test scrub: the throwing stub actually rejected the call", threw, threw);
  const scrubbedCaughtMessage = scrubSecrets(caughtMessage);
  check(
    "self-test scrub: the caught top-level error is clean after scrubSecrets",
    !scrubbedCaughtMessage.includes(fakeSecret) && scrubbedCaughtMessage.includes("[redacted]"),
    scrubbedCaughtMessage
  );
  const rawSnapshot = scrubContext.snapshot();
  const rawLeaked = rawSnapshot.traces.some(
    (trace) => (trace.error ?? "").includes(fakeSecret) || (trace.rawResponse ?? "").includes(fakeSecret)
  );
  console.log(
    `  (info) internal model-call trace ${rawLeaked ? "DOES" : "does not"} carry the raw secret pre-scrub -- this is why writeProbeRunFile scrubs the whole serialized blob, not field-by-field.`
  );
  const scrubRunFile = buildProbeRunFile({
    runId: scrubRunId,
    fullModelId: scrubModel.modelId,
    startedAt: scrubStartedAt,
    completedAt: new Date().toISOString(),
    status: "failed",
    context: scrubContext,
    team: scrubTeam,
  });
  const scrubOutPath = writeProbeRunFile(outDir, ["selftest", "scrub"], scrubModel.modelId, scrubRunFile);
  const scrubFileText = readFileSync(scrubOutPath, "utf8");
  check(
    "self-test scrub: the written run file contains no raw secret and does contain the redaction marker",
    !scrubFileText.includes(fakeSecret) && scrubFileText.includes("[redacted]"),
    scrubOutPath
  );

  if (failures === 0) {
    console.log("\nPASS");
    process.exit(0);
  } else {
    console.log(`\nFAIL ${failures} check(s) failed`);
    process.exit(1);
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.selfTest) {
    await runSelfTest(args.out ?? DEFAULT_OUT_DIR);
    return;
  }

  const cases = resolveCases(args.cases);

  if (!args.models) {
    printUsage();
    process.exit(2);
  }
  const models = resolveModels(args.models);

  if (args.dryRun) {
    runDryRun(cases, models, args.label);
    return;
  }

  if (!args.store) {
    console.error("--store <path-to-store.json> is required (unless --dry-run or --self-test).");
    process.exit(2);
  }

  const credentialsByProvider = loadProviderCredentials(args.store);
  // Validate every model's credentials BEFORE making any calls, so a later
  // missing key never wastes an earlier model's real API spend.
  for (const model of models) {
    const credentials = credentialsByProvider.get(model.providerId);
    if (!credentials) {
      console.error(
        `No API key found for provider "${model.providerId}" in --store. Configure it in Settings first.`
      );
      process.exit(2);
    }
    // nvidia is an account-runner provider (lib/providers/nvidia.ts,
    // credentialMode "provider-api-key-with-runner-token"): its streamChat
    // errors immediately without a runner baseURL + runnerToken, so failing
    // the preflight here beats burning retry sleeps per case on a
    // guaranteed error (mirrored from probe-gameiq-pack.mts).
    if (model.providerId === "nvidia" && (!credentials.baseURL || !credentials.runnerToken)) {
      const missing = [
        !credentials.baseURL ? "runner URL (baseURL)" : null,
        !credentials.runnerToken ? "runner token" : null,
      ]
        .filter(Boolean)
        .join(" and ");
      console.error(
        `nvidia models call through the local account-provider runner, and the store's nvidia row is missing its ${missing}. ` +
          "Start the runner (node lib/account-provider-runner.mjs, or the copy served at /account-provider-runner.mjs), " +
          "save its URL + token on the Settings page's NVIDIA provider tab, then re-export store.json."
      );
      process.exit(2);
    }
  }

  // See the file header comment (wiring point 1): the certified path reads
  // the browser client store unconditionally; this test-only seam makes
  // that safe under plain Node/tsx without touching any lib/ file.
  __resetBenchmarkStoreForTests();

  const streamChat = createProbeStreamChat(credentialsByProvider);
  const outDir = args.out ?? DEFAULT_OUT_DIR;

  console.log(
    `ToolReliability probe: pack v${TOOL_RELIABILITY_CASE_PACK_VERSION}, ${cases.length} case(s), ${models.length} model(s).`
  );
  if (args.label) console.log(`label: ${args.label}`);

  let anyAttempt = false;
  for (const model of models) {
    const hadAttempt = await probeModelLive({
      model,
      streamChat,
      cases,
      timeoutMs: args.timeoutMs,
      maxTokens: args.maxTokens,
      label: args.label,
      outDir,
    });
    anyAttempt = anyAttempt || hadAttempt;
  }

  if (models.length > 0 && !anyAttempt) {
    console.error("\nAll models failed before producing an attempt -- check credentials/runner setup above.");
    process.exitCode = 1;
  }
}

main()
  .then(() => {
    // Explicit exit: an abandoned timed-out provider stream can keep a socket
    // handle alive and delay natural process exit long after the work is
    // done. process.exitCode (set on the "all models failed" path) is
    // honored rather than overridden.
    process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
    console.error(
      scrubSecrets(error instanceof Error ? (error.stack ?? error.message) : String(error))
    );
    process.exit(1);
  });
