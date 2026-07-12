/* Headless GameIQ pack probe for the Phase D difficulty gate.
 *
 * Calls real (or, under --self-test, stubbed) models directly against a
 * GameIQ scenario pack, OUTSIDE the certified benchmark UI/budget machinery,
 * so the Battleship v2 gate probes (plan Task 6) don't need a browser tab
 * open. Emits a run-file-shaped JSON per model to --out so the existing
 * GameIQ tooling accepts it unchanged:
 *   - scripts/audit-gameiq-consensus.mts
 *   - scripts/classify-gameiq-consensus.mts
 *   - scripts/replay-gameiq-traces.mts
 *   - lib/benchmark/gameiq/trace-replay.ts's resolvePackTraceReplay
 * Every emitted trace carries a scenarioId (the scenarioId-keyed pairing
 * branch of resolvePackTraceReplay), and runs[0].modelIds carries the single
 * probed model id, matching what those tools read (run.runs[0].modelIds,
 * traces filtered by caseId/scenarioId).
 *
 * Reads provider keys from the user's store.json AT RUNTIME, from --store.
 * Key values are NEVER printed or logged, on any code path, including
 * errors — only provider ids and file paths appear in output. An encrypted
 * store is refused outright (exit 2); this tool never attempts to decrypt
 * one.
 *
 * Run:
 *   npx tsx scripts/probe-gameiq-pack.mts --pack <packId> --models <id,id,...> \
 *     --store <path-to-store.json> --out <dir> [--scenarios <id,id>] [--dry-run]
 *   npx tsx scripts/probe-gameiq-pack.mts --self-test --pack <packId> --out <dir>
 *
 * --dry-run resolves models/scenarios and prints the call plan with ZERO
 * network activity. It does not read --store (model resolution needs no
 * key).
 *
 * --self-test runs the entire pipeline (call -> trace -> file -> replay)
 * against an in-script stub AIProvider that answers every scenario with its
 * first keyed expected action (scenario.expectedActions[0], which for every
 * GameIQ pack is constructed to be >= GAMEIQ_CORRECT_QUALITY_BAR — see
 * lib/benchmark/gameiq/battleship-v2.ts's makeV2Scenario), asserts every
 * scenario replays correct, and prints PASS/FAIL. Zero network calls; no
 * --store needed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getGameIqScenarioPackById,
  resolvePackTraceReplay,
  runGameIqScenarios,
  type GameIqScenario,
  type GameIqScenarioPack,
  type PackTraceRow,
} from "../lib/benchmark/gameiq";
import {
  gameIqScenarioPrompt,
  gameIqStructuredOutputForScenario,
} from "../lib/benchmark/gameiq/certified-runner";
import { anthropicProvider } from "../lib/providers/anthropic";
import { xaiProvider } from "../lib/providers/xai";
import { nvidiaProvider } from "../lib/providers/nvidia";
import {
  parseModelId,
  type AIProvider,
  type ChatMessage,
  type ChatParams,
  type StreamChunk,
} from "../lib/providers/base";

// Byte-identical to the system line the certified GameIQ path sends
// (lib/benchmark/gameiq/certified-runner.ts, inside
// runCertifiedGameIqAttempt's moveProvider). Duplicated here — not
// imported — because that string is a local const, not an export, and this
// task is scoped to a single one-line export change in that file
// (gameIqStructuredOutputForScenario only). If that system line ever
// changes, update it here too.
const GAMEIQ_CERTIFIED_SYSTEM_PROMPT =
  "You are a certified GameIQ benchmark participant. Return only the requested structured JSON.";

const GAMEIQ_PROBE_MAX_TOKENS = 16_384;
const GAMEIQ_PROBE_TIMEOUT_MS = 120_000;
const GAMEIQ_PROBE_RETRY_DELAYS_MS = [2_000, 8_000];

const SUPPORTED_PROVIDERS: Record<string, AIProvider> = {
  anthropic: anthropicProvider,
  xai: xaiProvider,
  nvidia: nvidiaProvider,
};

// ─── run-file shape (must satisfy the consumer scripts above unchanged) ────

interface ProbeTraceRow extends Omit<PackTraceRow, "scenarioId"> {
  id: string;
  scenarioId: string;
  modelId: string;
  providerId: string;
  retryHistory: unknown[];
}

interface ProbeRunFile {
  version: 2;
  runs: Array<{
    id: string;
    modelIds: string[];
    status: "completed";
    startedAt: string;
    completedAt: string;
  }>;
  traces: ProbeTraceRow[];
  attemptsV2: unknown[];
  verifierResults: unknown[];
  failures: unknown[];
  caseV2: unknown[];
  suites: unknown[];
  cases: unknown[];
  attempts: unknown[];
  metricValues: unknown[];
  artifacts: unknown[];
  runEvents: unknown[];
  toolCallTraces: unknown[];
  teamCompositions: unknown[];
  harnessCertifications: unknown[];
}

// ─── CLI arg parsing ────────────────────────────────────────────────────────

interface CliArgs {
  pack?: string;
  models?: string;
  store?: string;
  out?: string;
  scenarios?: string;
  dryRun: boolean;
  selfTest: boolean;
}

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  npx tsx scripts/probe-gameiq-pack.mts --pack <packId> --models <id,id,...> --store <path-to-store.json> --out <dir> [--scenarios <id,id>] [--dry-run]",
      "  npx tsx scripts/probe-gameiq-pack.mts --self-test --pack <packId> --out <dir>",
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
      case "--pack":
        args.pack = takeValue(argv, ++i, "--pack");
        break;
      case "--models":
        args.models = takeValue(argv, ++i, "--models");
        break;
      case "--store":
        args.store = takeValue(argv, ++i, "--store");
        break;
      case "--out":
        args.out = takeValue(argv, ++i, "--out");
        break;
      case "--scenarios":
        args.scenarios = takeValue(argv, ++i, "--scenarios");
        break;
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

// ─── store.json parsing (redacted error paths — never print key values) ───

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
}

interface StoreData {
  providerKeys?: StoreProviderKeyRow[];
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
 * Reads --store (an app store.json envelope — see lib/client/crypto-box.ts's
 * Envelope: { v, encrypted, salt?, iv?, data }), refuses an encrypted store,
 * and returns providerId -> apiKey from the plaintext data's providerKeys
 * array (lib/db/schema.ts's ProviderKey[] — an array of rows, not a plain
 * object). Never logs raw/envelope/data contents; only the file path and
 * provider ids ever reach console output.
 */
function loadProviderKeyMap(storePath: string): Map<string, string> {
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
      "Store is encrypted at rest. Unlock it in the app and export/copy a plaintext store.json first — this tool never decrypts a store."
    );
    process.exit(2);
  }
  const data = parseJsonOrExit<StoreData>(envelope.data, "--store envelope's data field");
  const rows = Array.isArray(data.providerKeys) ? data.providerKeys : [];
  const map = new Map<string, string>();
  for (const row of rows) {
    if (
      row &&
      typeof row.providerId === "string" &&
      typeof row.apiKey === "string" &&
      row.apiKey.length > 0
    ) {
      map.set(row.providerId, row.apiKey);
    }
  }
  return map;
}

// ─── model resolution ───────────────────────────────────────────────────────

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
    console.error("--models must list at least one model id (e.g. xai:grok-4.5).");
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

// ─── model call: accumulate stream, timeout, retry ─────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Accumulates one streamChat call's token chunks into text, enforcing an
 * overall (not per-chunk) deadline for the whole call. Mirrors the
 * timeout/iterator-close shape of callCertifiedModelOnce's
 * withCertifiedModelCallTimeout (lib/benchmark/certified/model-call.ts),
 * simplified for standalone use (no budget/trace plumbing). */
async function streamToText(
  stream: AsyncIterable<StreamChunk>,
  timeoutMs: number
): Promise<string> {
  const iterator = stream[Symbol.asyncIterator]();
  let raw = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Provider call timed out after ${timeoutMs}ms.`)),
      timeoutMs
    );
  });
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), timeout]);
      if (next.done) break;
      const chunk = next.value;
      if (chunk.type === "token" && chunk.content) {
        raw += chunk.content;
      } else if (chunk.type === "error") {
        throw new Error(chunk.error ?? "Provider returned an error.");
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    void iterator.return?.().catch(() => undefined);
  }
  if (raw.trim().length === 0) {
    // Free-tier flakiness (e.g. MiniMax) surfaces as an empty response as
    // often as a thrown error; treating it as a failure lets it share the
    // retry path below instead of silently recording a blank trace.
    throw new Error("Empty response from provider.");
  }
  return raw;
}

async function callModelWithRetry(
  provider: AIProvider,
  params: ChatParams,
  retryDelaysMs: number[],
  timeoutMs: number
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (attempt > 0) {
      await sleep(retryDelaysMs[attempt - 1]);
    }
    try {
      return await streamToText(provider.streamChat(params), timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ─── one scenario call -> one trace row ─────────────────────────────────────

async function callScenario(input: {
  provider: AIProvider;
  apiKey: string;
  bareModel: string;
  fullModelId: string;
  providerId: string;
  pack: GameIqScenarioPack;
  scenario: GameIqScenario;
  scenarioIndex: number;
  totalScenarios: number;
}): Promise<ProbeTraceRow> {
  const startedAt = new Date().toISOString();
  const messages: ChatMessage[] = [
    { role: "system", content: GAMEIQ_CERTIFIED_SYSTEM_PROMPT },
    {
      role: "user",
      content: gameIqScenarioPrompt(input.scenario, input.scenarioIndex, input.totalScenarios),
    },
  ];
  const params: ChatParams = {
    apiKey: input.apiKey,
    model: input.bareModel,
    messages,
    maxTokens: GAMEIQ_PROBE_MAX_TOKENS,
    temperature: 0,
    structuredOutput: gameIqStructuredOutputForScenario(input.scenario),
  };

  let rawResponse = "";
  let callError: string | null = null;
  try {
    rawResponse = await callModelWithRetry(
      input.provider,
      params,
      GAMEIQ_PROBE_RETRY_DELAYS_MS,
      GAMEIQ_PROBE_TIMEOUT_MS
    );
  } catch (error) {
    callError = error instanceof Error ? error.message : String(error);
  }
  const completedAt = new Date().toISOString();

  let parsedResponseJson: string | undefined;
  if (rawResponse) {
    try {
      JSON.parse(rawResponse);
      parsedResponseJson = rawResponse; // raw response, only when it parses
    } catch {
      // Not valid JSON: leave parsedResponseJson unset. resolvePackTraceReplay
      // treats this scenario as unusable (same as a transport gap) rather
      // than crashing.
    }
  }

  return {
    id: `probe:${input.pack.id}:${input.scenario.id}:${input.fullModelId}`,
    caseId: input.pack.id,
    scenarioId: input.scenario.id,
    modelId: input.fullModelId,
    providerId: input.providerId,
    startedAt,
    completedAt,
    latencyMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    rawResponse: callError ? `ERROR: ${callError}` : rawResponse,
    ...(parsedResponseJson !== undefined ? { parsedResponseJson } : {}),
    retryHistory: [],
  };
}

// ─── one model over a (possibly filtered) scenario list -> one run file ────

async function probeModel(input: {
  provider: AIProvider;
  apiKey: string;
  bareModel: string;
  fullModelId: string;
  providerId: string;
  pack: GameIqScenarioPack;
  scenarios: GameIqScenario[];
  onBeforeScenario?: (scenario: GameIqScenario) => void;
}): Promise<ProbeRunFile> {
  const runStartedAt = new Date().toISOString();
  const traces: ProbeTraceRow[] = [];
  for (let i = 0; i < input.scenarios.length; i++) {
    const scenario = input.scenarios[i];
    input.onBeforeScenario?.(scenario);
    const trace = await callScenario({
      provider: input.provider,
      apiKey: input.apiKey,
      bareModel: input.bareModel,
      fullModelId: input.fullModelId,
      providerId: input.providerId,
      pack: input.pack,
      scenario,
      scenarioIndex: i,
      totalScenarios: input.scenarios.length,
    });
    traces.push(trace);
    const outcome = trace.parsedResponseJson
      ? "ok"
      : `NO PARSE${trace.rawResponse?.startsWith("ERROR:") ? ` (${trace.rawResponse})` : ""}`;
    console.log(`  [${i + 1}/${input.scenarios.length}] ${scenario.id} -> ${outcome}`);
  }
  const runCompletedAt = new Date().toISOString();
  return {
    version: 2,
    runs: [
      {
        id: `probe:${input.pack.id}:${input.fullModelId}:${runStartedAt}`,
        modelIds: [input.fullModelId],
        status: "completed",
        startedAt: runStartedAt,
        completedAt: runCompletedAt,
      },
    ],
    traces,
    attemptsV2: [],
    verifierResults: [],
    failures: [],
    caseV2: [],
    suites: [],
    cases: [],
    attempts: [],
    metricValues: [],
    artifacts: [],
    runEvents: [],
    toolCallTraces: [],
    teamCompositions: [],
    harnessCertifications: [],
  };
}

// ─── grade summary: replay the emitted file through the real scorer ───────

async function replayAndPrint(
  pack: GameIqScenarioPack,
  filePath: string,
  modelLabel: string
): Promise<{ allCorrect: boolean; replayed: number; total: number }> {
  const run = JSON.parse(readFileSync(filePath, "utf8")) as ProbeRunFile;
  const packTraces = (run.traces as PackTraceRow[]).filter((t) => t.caseId === pack.id);
  const { replayScenarios, actions, replayed, total, partial } = resolvePackTraceReplay(
    pack,
    packTraces
  );

  let cursor = 0;
  const result = await runGameIqScenarios({
    runId: "probe-replay",
    modelId: modelLabel,
    teamCompositionId: "probe",
    scenarios: replayScenarios,
    moveProvider: () => ({ action: actions[cursor++] }),
  });

  console.log(
    `\n=== ${modelLabel}: ${pack.label} replay (${replayed}/${total}${partial ? " PARTIAL" : ""}) ===`
  );
  console.log(`  ${"scenarioId".padEnd(42)} grade   correct`);
  for (const r of result.caseResults) {
    console.log(
      `  ${r.scenarioId.padEnd(42)} ${r.actionQuality.toFixed(4).padStart(6)}   ${r.correct ? "yes" : "no"}`
    );
  }
  console.log(
    `  score=${result.score} status=${result.attempt.status} correct=${result.metrics.correctActions}/${replayed}`
  );

  const allCorrect =
    replayed === total && result.caseResults.every((r) => r.correct);
  return { allCorrect, replayed, total };
}

// ─── --dry-run ──────────────────────────────────────────────────────────────

function runDryRun(
  pack: GameIqScenarioPack,
  scenarios: GameIqScenario[],
  models: ResolvedModel[]
): void {
  console.log("DRY RUN -- no network calls.");
  console.log(`pack: ${pack.id} (${pack.label})`);
  console.log(
    `scenarios: ${scenarios.length}${scenarios.length !== pack.scenarios.length ? ` of ${pack.scenarios.length} (filtered)` : ""}`
  );
  console.log(`models (${models.length}):`);
  for (const model of models) {
    console.log(`  ${model.fullModelId}  (provider=${model.providerId}, model=${model.bareModel})`);
  }
  console.log(`planned calls: ${models.length} x ${scenarios.length} = ${models.length * scenarios.length}`);
}

// ─── --self-test ────────────────────────────────────────────────────────────

async function runSelfTest(packId: string, outDir: string): Promise<void> {
  const pack = getGameIqScenarioPackById(packId);
  if (!pack) {
    console.log(`FAIL: unknown pack id for --self-test: ${packId}`);
    process.exit(1);
  }

  // The stub provider answers with the CURRENT scenario's first keyed
  // expected action. ChatParams carries only prompt text, not the scenario
  // object, so the calling loop below sets this closure var immediately
  // before each streamChat call (sequential, no concurrency -> race-free).
  let currentScenario: GameIqScenario | null = null;
  const stubProvider: AIProvider = {
    id: "self-test-stub",
    name: "Self-test stub (no network)",
    listModels: () => [],
    async validateApiKey() {
      return true;
    },
    async *streamChat(): AsyncIterable<StreamChunk> {
      if (!currentScenario) {
        throw new Error("self-test stub invoked with no scenario in context");
      }
      const action = currentScenario.expectedActions[0]?.action;
      if (action === undefined) {
        throw new Error(`self-test stub: scenario ${currentScenario.id} has no expectedActions`);
      }
      yield { type: "token", content: JSON.stringify({ action }) };
      yield { type: "done" };
    },
  };

  const fullModelId = "self-test:stub-model";
  console.log(`--self-test: pack=${packId} scenarios=${pack.scenarios.length}`);

  const runFile = await probeModel({
    provider: stubProvider,
    apiKey: "stub",
    bareModel: "stub-model",
    fullModelId,
    providerId: "self-test",
    pack,
    scenarios: pack.scenarios,
    onBeforeScenario: (scenario) => {
      currentScenario = scenario;
    },
  });

  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `probe-${packId}-${slug(fullModelId)}.json`);
  writeFileSync(outPath, JSON.stringify(runFile, null, 2));
  console.log(`wrote ${outPath}`);

  const { allCorrect, replayed, total } = await replayAndPrint(pack, outPath, fullModelId);

  if (!allCorrect || replayed !== total) {
    console.log(
      `\nFAIL self-test: expected all ${total} scenarios to replay correct, got ${replayed}/${total} replayed, allCorrect=${allCorrect}`
    );
    process.exit(1);
  }
  console.log(`\nPASS self-test: all ${total} scenarios replayed correct for pack ${packId}.`);
  process.exit(0);
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.selfTest) {
    if (!args.pack) {
      console.error("--self-test requires --pack <packId>.");
      process.exit(2);
    }
    if (!args.out) {
      console.error("--self-test requires --out <dir>.");
      process.exit(2);
    }
    await runSelfTest(args.pack, args.out);
    return;
  }

  if (!args.pack) {
    printUsage();
    process.exit(2);
  }
  const pack = getGameIqScenarioPackById(args.pack);
  if (!pack) {
    console.error(`Unknown GameIQ pack id: ${args.pack}`);
    process.exit(2);
  }

  const scenarioFilter = args.scenarios
    ? new Set(
        args.scenarios
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
      )
    : null;
  const scenarios = scenarioFilter
    ? pack.scenarios.filter((scenario) => scenarioFilter.has(scenario.id))
    : pack.scenarios;
  if (scenarios.length === 0) {
    console.error(`--scenarios filter matched zero scenarios in pack ${pack.id}.`);
    process.exit(2);
  }

  if (!args.models) {
    printUsage();
    process.exit(2);
  }
  const models = resolveModels(args.models);

  if (args.dryRun) {
    runDryRun(pack, scenarios, models);
    return;
  }

  if (!args.out) {
    console.error("--out <dir> is required (unless --dry-run).");
    process.exit(2);
  }
  if (!args.store) {
    console.error("--store <path-to-store.json> is required (unless --dry-run).");
    process.exit(2);
  }

  const keyMap = loadProviderKeyMap(args.store);
  // Validate every model has a key BEFORE making any calls, so a later
  // missing key never wastes an earlier model's real API spend.
  for (const model of models) {
    if (!keyMap.has(model.providerId)) {
      console.error(
        `No API key found for provider "${model.providerId}" in --store. Configure it in Settings first.`
      );
      process.exit(2);
    }
  }

  mkdirSync(args.out, { recursive: true });
  for (const model of models) {
    const apiKey = keyMap.get(model.providerId) as string;
    console.log(`\n=== ${model.fullModelId}: probing ${scenarios.length} scenario(s) ===`);
    const runFile = await probeModel({
      provider: model.provider,
      apiKey,
      bareModel: model.bareModel,
      fullModelId: model.fullModelId,
      providerId: model.providerId,
      pack,
      scenarios,
    });
    const outPath = join(args.out, `probe-${pack.id}-${slug(model.fullModelId)}.json`);
    writeFileSync(outPath, JSON.stringify(runFile, null, 2));
    console.log(`wrote ${outPath}`);
    await replayAndPrint(pack, outPath, model.fullModelId);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
