/* Build-failure miner (Stateful ToolReliability charter, PR B Task B2) —
 * mines real Build-mode tool-use failures from a user's AIBoard store folder
 * so stateful ToolReliability cases can be authored from EVIDENCE rather than
 * invented. This is the tool that produced the mined-class/count/model table
 * in docs/superpowers/specs/2026-07-21-stateful-toolreliability-design.md;
 * it is committed (not left as a scratchpad throwaway) so the mining is
 * reproducible and auditable.
 *
 * Reads ONLY from the store folder's discussion build checkpoints and any
 * recovery/migration export blobs sitting alongside them — never from a
 * live provider, never from application source. Output is AGGREGATE ONLY:
 * counts, tallies, and short SCRUBBED+TRUNCATED text previews (max 220
 * chars) for classification — never a raw dump of a checkpoint file.
 *
 * Secret safety (do not weaken): SKIP_KEYS names fields the walker refuses
 * to descend into AT ALL — providerKeys/apiKey/tokens/attachment bytes never
 * even reach the aggregation step, let alone get printed. Every text sample
 * that IS surfaced is additionally run through scrub(), which replaces long
 * hex runs (>=32 chars — API keys, hashes, ids) with `<hex>` and `sk-...`
 * prefixed tokens with `<key>`. Both layers are load-bearing; keep them
 * exactly as written here if you touch this file.
 *
 * Run:
 *   npx tsx scripts/mine-build-failures.mts <store-root-folder>
 *   npx tsx scripts/mine-build-failures.mts --self-test
 *   npx tsx scripts/mine-build-failures.mts --help
 *
 * <store-root-folder> is the folder that directly contains a `discussions/`
 * subfolder (e.g. the AIBoard local-folder storage root) — mirroring the
 * File System Access folder adapter's own layout (lib/client/storage-adapter.ts).
 * The miner scans every checkpoint.json file under each
 * `discussions/<id>/build/` folder, plus any `_recovery-` / `_migration-
 * backup-` prefixed sibling folders (produced by the
 * client store's own recovery/migration paths) that carry a
 * `source-export.json` or `store.json` blob.
 *
 * --self-test runs the walker over a SMALL INLINE SYNTHETIC object (no
 * filesystem, no real store) and asserts: (1) problems/commandProblems/
 * fingerprints/taskFails/stopCauses aggregate as expected from the synthetic
 * fixture; (2) a fake hex-looking token embedded in a synthetic message
 * comes out scrubbed as `<hex>`; (3) a synthetic `providerKeys` field is
 * never visited at all (SKIP_KEYS), so a secret placed there can never
 * surface in the aggregation even unscrubbed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ─── secret safety: SKIP_KEYS + scrub/trunc (keep EXACTLY as written) ──────

/** Fields the walker refuses to descend into at all — never inspected, never printed. */
const SKIP_KEYS = new Set([
  "providerKeys",
  "apiKey",
  "apiKeyEncrypted",
  "token",
  "runnerToken",
  "attachments",
  "attachmentData",
  "data",
  "base64",
  "keyCiphertext",
]);

/** Replaces long hex runs (API keys/hashes/ids) and sk-... tokens, collapses whitespace. */
function scrub(value: unknown): string {
  return String(value ?? "")
    .replace(/[a-f0-9]{32,}/gi, "<hex>")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "<key>")
    .replace(/\s+/g, " ")
    .trim();
}

function trunc(value: string, maxChars = 220): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

// ─── aggregation shapes ─────────────────────────────────────────────────────

export interface MinedProblem {
  code: string;
  severity: string;
  source: string;
  modelId: string | null;
  modelName: string | null;
  action: string | null;
  message: string;
  details: string | null;
  file: string;
}

export interface MinedCommandProblem {
  command: string;
  exitCode: number;
  denied: boolean;
  outputPreview: string;
  file: string;
}

export interface MinedTaskFail {
  title: string;
  failCount: number;
  status: string | null;
  file: string;
}

export interface MinedStopCause {
  stopReason: string | null;
  file: string;
  primary: string | null;
}

export interface MinedCheckpointSeen {
  file: string;
  wave: string | number | null;
  status: string | null;
  tasks: number;
}

export interface MinerAggregation {
  problems: MinedProblem[];
  commandProblems: MinedCommandProblem[];
  /** fingerprint text -> max count seen across scanned files. */
  fingerprints: Map<string, number>;
  taskFails: MinedTaskFail[];
  stopCauses: MinedStopCause[];
  checkpointsSeen: MinedCheckpointSeen[];
}

export function createMinerAggregation(): MinerAggregation {
  return {
    problems: [],
    commandProblems: [],
    fingerprints: new Map(),
    taskFails: [],
    stopCauses: [],
    checkpointsSeen: [],
  };
}

// ─── walker ─────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function looksLikeProblem(node: unknown): node is {
  code: string;
  severity: string;
  source: string;
  message: string;
  modelId?: unknown;
  modelName?: unknown;
  action?: unknown;
  details?: unknown;
} {
  const rec = asRecord(node);
  return (
    !!rec &&
    typeof rec.code === "string" &&
    typeof rec.severity === "string" &&
    typeof rec.source === "string" &&
    typeof rec.message === "string"
  );
}

function looksLikeCommandProblem(node: unknown): node is {
  command: string;
  exitCode: number;
  denied?: unknown;
  outputPreview: unknown;
} {
  const rec = asRecord(node);
  return (
    !!rec &&
    typeof rec.command === "string" &&
    typeof rec.exitCode === "number" &&
    "outputPreview" in rec
  );
}

/**
 * Recursively walks a parsed checkpoint/store blob, aggregating mined
 * failure evidence into `agg`. Pure with respect to its inputs: never reads
 * the filesystem, never mutates `node`, and any field named in SKIP_KEYS is
 * skipped entirely rather than recursed into.
 */
export function walkMinedNode(
  node: unknown,
  file: string,
  agg: MinerAggregation,
  depth = 0
): void {
  if (!node || typeof node !== "object" || depth > 24) return;

  if (Array.isArray(node)) {
    for (const item of node) walkMinedNode(item, file, agg, depth + 1);
    return;
  }

  const rec = node as Record<string, unknown>;

  if (looksLikeProblem(rec)) {
    agg.problems.push({
      code: rec.code,
      severity: rec.severity,
      source: rec.source,
      modelId: stringOrNull(rec.modelId),
      modelName: stringOrNull(rec.modelName),
      action: stringOrNull(rec.action),
      message: trunc(scrub(rec.message)),
      details: rec.details != null ? trunc(scrub(rec.details), 300) : null,
      file,
    });
  }

  if (looksLikeCommandProblem(rec)) {
    agg.commandProblems.push({
      command: trunc(scrub(rec.command), 120),
      exitCode: rec.exitCode,
      denied: !!rec.denied,
      outputPreview: trunc(scrub(rec.outputPreview), 200),
      file,
    });
  }

  const fingerprints = asRecord(rec.failureFingerprints);
  if (fingerprints) {
    for (const [key, value] of Object.entries(fingerprints)) {
      const scrubbedKey = trunc(scrub(key), 160);
      const count = typeof value === "number" ? value : Number(value) || 0;
      agg.fingerprints.set(scrubbedKey, Math.max(agg.fingerprints.get(scrubbedKey) ?? 0, count));
    }
  }

  if (Array.isArray(rec.tasks) && rec.status !== undefined && rec.wave !== undefined) {
    const wave = rec.wave;
    agg.checkpointsSeen.push({
      file,
      wave: typeof wave === "string" || typeof wave === "number" ? wave : null,
      status: stringOrNull(rec.status),
      tasks: rec.tasks.length,
    });
    for (const task of rec.tasks) {
      const taskRec = asRecord(task);
      const failCount = typeof taskRec?.failCount === "number" ? taskRec.failCount : 0;
      if (taskRec && failCount > 0) {
        agg.taskFails.push({
          title: trunc(scrub(taskRec.title), 90),
          failCount,
          status: stringOrNull(taskRec.status),
          file,
        });
      }
    }
  }

  if (rec.stopReason !== undefined && rec.primaryCause !== undefined) {
    const primaryCause = asRecord(rec.primaryCause);
    agg.stopCauses.push({
      stopReason: stringOrNull(rec.stopReason),
      file,
      primary: primaryCause
        ? `${stringOrNull(primaryCause.code) ?? "?"}: ${trunc(scrub(primaryCause.message), 160)}`
        : null,
    });
  }

  for (const [key, value] of Object.entries(rec)) {
    if (SKIP_KEYS.has(key)) continue; // never descend into secret-bearing fields
    walkMinedNode(value, file, agg, depth + 1);
  }
}

// ─── filesystem discovery + report rendering (real-run mode only) ─────────

function discoverStoreFiles(storeRoot: string): string[] {
  const files: string[] = [];

  const discussionsDir = join(storeRoot, "discussions");
  if (existsSync(discussionsDir)) {
    for (const discussionId of readdirSync(discussionsDir)) {
      const buildDir = join(discussionsDir, discussionId, "build");
      if (!existsSync(buildDir)) continue;
      for (const entry of readdirSync(buildDir)) {
        if (entry.startsWith("checkpoint.json")) files.push(join(buildDir, entry));
      }
    }
  }

  if (existsSync(storeRoot)) {
    for (const entry of readdirSync(storeRoot)) {
      if (!/^_(recovery|migration-backup)-/.test(entry)) continue;
      const dir = join(storeRoot, entry);
      if (!statSync(dir).isDirectory()) continue;
      for (const candidate of ["source-export.json", "store.json"]) {
        const candidatePath = join(dir, candidate);
        if (existsSync(candidatePath)) files.push(candidatePath);
      }
    }
  }

  return files;
}

function parseStoreBlob(raw: string): unknown {
  let parsed: unknown = JSON.parse(raw);
  // Legacy store blobs sometimes double-encode (a JSON string) or wrap the
  // real payload in an envelope object.
  if (typeof parsed === "string") parsed = JSON.parse(parsed);
  const rec = asRecord(parsed);
  if (rec && typeof rec.payload === "string") {
    try {
      parsed = JSON.parse(rec.payload);
    } catch {
      // leave parsed as-is; the envelope itself still gets walked
    }
  }
  return parsed;
}

function tally<T>(items: T[], keyFn: (item: T) => string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function renderReport(agg: MinerAggregation, filesScanned: number): void {
  console.log(`files scanned: ${filesScanned}; checkpoints found: ${agg.checkpointsSeen.length}`);
  for (const checkpoint of agg.checkpointsSeen) {
    console.log(
      `  ${checkpoint.file} wave=${checkpoint.wave} status=${checkpoint.status} tasks=${checkpoint.tasks}`
    );
  }

  console.log(`\n== problems: ${agg.problems.length} total ==`);
  console.log("by code:");
  for (const [key, count] of tally(agg.problems, (p) => p.code)) {
    console.log(`  ${String(count).padStart(4)}  ${key}`);
  }
  console.log("by source:");
  for (const [key, count] of tally(agg.problems, (p) => p.source)) {
    console.log(`  ${String(count).padStart(4)}  ${key}`);
  }
  console.log("by severity:");
  for (const [key, count] of tally(agg.problems, (p) => p.severity)) {
    console.log(`  ${String(count).padStart(4)}  ${key}`);
  }
  console.log("by model:");
  for (const [key, count] of tally(agg.problems, (p) => p.modelName ?? p.modelId ?? "(none)")) {
    console.log(`  ${String(count).padStart(4)}  ${key}`);
  }
  console.log("by code x action (top 25):");
  for (const [key, count] of tally(agg.problems, (p) => `${p.code} | action=${p.action ?? "-"}`).slice(0, 25)) {
    console.log(`  ${String(count).padStart(4)}  ${key}`);
  }

  console.log("\n== sample messages (first 2 per code) ==");
  const seenPerCode = new Map<string, number>();
  for (const problem of agg.problems) {
    const seen = seenPerCode.get(problem.code) ?? 0;
    if (seen >= 2) continue;
    seenPerCode.set(problem.code, seen + 1);
    const modelSuffix = problem.modelName ? `/${problem.modelName}` : "";
    console.log(`[${problem.code}/${problem.source}${modelSuffix}] ${problem.message}`);
    if (problem.details) console.log(`      details: ${problem.details}`);
  }

  console.log(`\n== command problems: ${agg.commandProblems.length} ==`);
  for (const [key, count] of tally(agg.commandProblems, (c) => `exit=${c.exitCode}${c.denied ? " denied" : ""}`)) {
    console.log(`  ${String(count).padStart(4)}  ${key}`);
  }
  for (const command of agg.commandProblems.slice(0, 10)) {
    console.log(`  $ ${command.command}  -> exit ${command.exitCode}${command.denied ? " (denied)" : ""}`);
  }

  console.log("\n== failure fingerprints (top 20) ==");
  for (const [key, count] of [...agg.fingerprints.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  x${count}  ${key}`);
  }

  console.log(`\n== tasks with failCount>0: ${agg.taskFails.length} ==`);
  for (const task of agg.taskFails.slice(0, 15)) {
    console.log(`  fail=${task.failCount} status=${task.status}  ${task.title}`);
  }

  console.log("\n== stop reports ==");
  for (const stop of agg.stopCauses) {
    console.log(`  [${stop.file}] reason=${stop.stopReason} primary=${stop.primary ?? "-"}`);
  }
}

function runRealMine(storeRoot: string): void {
  const files = discoverStoreFiles(storeRoot);
  const agg = createMinerAggregation();

  for (const file of files) {
    const shortName = file.replace(/\\/g, "/").replace(`${storeRoot.replace(/\\/g, "/")}/`, "");
    try {
      const raw = readFileSync(file, "utf8");
      const parsed = parseStoreBlob(raw);
      walkMinedNode(parsed, shortName, agg);
    } catch (error) {
      console.log(`SKIP ${shortName}: ${scrub(error instanceof Error ? error.message : String(error)).slice(0, 120)}`);
    }
  }

  renderReport(agg, files.length);
}

// ─── --self-test: inline synthetic object, zero filesystem ────────────────

function runSelfTest(): void {
  let failures = 0;
  function check(name: string, ok: boolean, detail?: unknown): void {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  }

  const fakeHexToken = "deadbeef".repeat(5); // 40 lowercase-hex chars, well over the 32-char floor
  const fakeApiKey = "sk-abcdefghijklmnopqrstuvwx";

  // A small inline synthetic store blob shaped like a real checkpoint.json:
  // one problem (message carries the fake hex token), one command problem,
  // one fingerprint, one wave/tasks checkpoint with a failing task, one stop
  // report — plus a `providerKeys` field carrying the fake API key that must
  // NEVER be visited (SKIP_KEYS), and a `token` field for the same reason.
  const syntheticStore = {
    providerKeys: [{ providerId: "openai", apiKey: fakeApiKey }],
    discussions: {
      "disc-1": {
        build: {
          checkpoint: {
            wave: 2,
            status: "running",
            tasks: [
              { title: "Implement widget", failCount: 0, status: "done" },
              { title: "Wire up settings panel", failCount: 3, status: "failed" },
            ],
            problems: [
              {
                code: "duplicate_tool_batch",
                severity: "warning",
                source: "architect",
                modelId: "openai:gpt-5.5",
                modelName: "GPT-5.5",
                action: "read_range",
                message: `Re-requested lines already served. trace=${fakeHexToken}`,
                details: `session token ${fakeHexToken}`,
              },
            ],
            commandProblems: [
              { command: "npm test", exitCode: 1, denied: false, outputPreview: "2 failing" },
            ],
            failureFingerprints: { "patch_did_not_apply:surcharge.ts": 4 },
            stopReport: {
              stopReason: "budget_exhausted",
              primaryCause: { code: "patch_did_not_apply", message: "SEARCH text did not match." },
            },
            token: "should-never-be-read-" + fakeHexToken,
          },
        },
      },
    },
  };

  const agg = createMinerAggregation();
  walkMinedNode(syntheticStore, "synthetic/checkpoint.json", agg);

  check("aggregates exactly one problem", agg.problems.length === 1, agg.problems);
  check(
    "problem carries model/action/code fields",
    agg.problems[0]?.code === "duplicate_tool_batch" &&
      agg.problems[0]?.modelName === "GPT-5.5" &&
      agg.problems[0]?.action === "read_range",
    agg.problems[0]
  );
  check(
    "the fake hex token is scrubbed to <hex> in the message",
    agg.problems[0]?.message.includes("<hex>") && !agg.problems[0]?.message.includes(fakeHexToken),
    agg.problems[0]?.message
  );
  check(
    "the fake hex token is scrubbed to <hex> in details too",
    agg.problems[0]?.details?.includes("<hex>") === true && !agg.problems[0]?.details?.includes(fakeHexToken),
    agg.problems[0]?.details
  );

  check("aggregates exactly one command problem", agg.commandProblems.length === 1, agg.commandProblems);
  check(
    "command problem exit code and preview aggregate",
    agg.commandProblems[0]?.exitCode === 1 && agg.commandProblems[0]?.outputPreview === "2 failing",
    agg.commandProblems[0]
  );

  check(
    "failure fingerprint aggregates with its count",
    agg.fingerprints.get("patch_did_not_apply:surcharge.ts") === 4,
    [...agg.fingerprints.entries()]
  );

  check(
    "checkpoint wave/status/task-count aggregates",
    agg.checkpointsSeen.length === 1 &&
      agg.checkpointsSeen[0]?.wave === 2 &&
      agg.checkpointsSeen[0]?.status === "running" &&
      agg.checkpointsSeen[0]?.tasks === 2,
    agg.checkpointsSeen
  );
  check(
    "only the failing task is recorded in taskFails",
    agg.taskFails.length === 1 && agg.taskFails[0]?.title === "Wire up settings panel" && agg.taskFails[0]?.failCount === 3,
    agg.taskFails
  );

  check(
    "stop report aggregates with a scrubbed primary-cause message",
    agg.stopCauses.length === 1 &&
      agg.stopCauses[0]?.stopReason === "budget_exhausted" &&
      agg.stopCauses[0]?.primary === "patch_did_not_apply: SEARCH text did not match.",
    agg.stopCauses
  );

  const wholeAggregationText = JSON.stringify({
    problems: agg.problems,
    commandProblems: agg.commandProblems,
    fingerprints: [...agg.fingerprints.entries()],
    taskFails: agg.taskFails,
    stopCauses: agg.stopCauses,
    checkpointsSeen: agg.checkpointsSeen,
  });
  check(
    "providerKeys (and the fake API key inside it) never appear anywhere in the aggregation — SKIP_KEYS blocks recursion",
    !wholeAggregationText.includes(fakeApiKey) && !wholeAggregationText.includes("providerId"),
    "checked whole aggregation for leaked provider-key content"
  );
  check(
    "the `token` field's raw value never appears in the aggregation either",
    !wholeAggregationText.includes("should-never-be-read"),
    "checked whole aggregation for the token field's raw value"
  );

  // A direct scrub() unit check, independent of the walker: the exact
  // transformation the design/task calls for.
  check(
    "scrub() turns a bare 32+ char hex run into <hex>",
    scrub(`prefix ${fakeHexToken} suffix`) === "prefix <hex> suffix",
    scrub(`prefix ${fakeHexToken} suffix`)
  );
  check(
    "scrub() turns an sk-... token into <key>",
    scrub(`Authorization: Bearer ${fakeApiKey}`) === "Authorization: Bearer <key>",
    scrub(`Authorization: Bearer ${fakeApiKey}`)
  );

  if (failures === 0) {
    console.log("PASS");
  } else {
    console.log(`FAIL ${failures} check(s) failed`);
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  npx tsx scripts/mine-build-failures.mts <store-root-folder>",
      "  npx tsx scripts/mine-build-failures.mts --self-test",
      "  npx tsx scripts/mine-build-failures.mts --help",
      "",
      "<store-root-folder> is the folder that directly contains a discussions/",
      "subfolder (the AIBoard local-folder storage layout). Scans every",
      "discussions/*/build/checkpoint.json* file plus any _recovery-*/",
      "_migration-backup-* sibling folder carrying source-export.json or",
      "store.json.",
      "",
      "Output is aggregate-only (counts/tallies + short scrubbed previews) —",
      "never a raw dump of a checkpoint file. providerKeys/apiKey/token/",
      "runnerToken/attachment fields are never even visited (SKIP_KEYS), and",
      "every text sample is scrubbed of long hex runs and sk-... tokens",
      "before being printed.",
    ].join("\n")
  );
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }
  if (args.includes("--self-test")) {
    runSelfTest();
    return;
  }

  const storeRoot = args[0];
  if (!storeRoot) {
    console.error("A <store-root-folder> argument is required (or pass --self-test / --help).");
    printUsage();
    process.exitCode = 2;
    return;
  }
  if (!existsSync(storeRoot)) {
    console.error(`Store root folder does not exist: ${storeRoot}`);
    process.exitCode = 2;
    return;
  }

  runRealMine(storeRoot);
}

main();
