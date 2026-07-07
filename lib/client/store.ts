/**
 * Client-side store. Loads a single JSON blob once (async) from a StorageAdapter,
 * keeps it in memory for synchronous reads, and persists mutations async
 * (debounced). Mirrors the server `lib/db` API so call sites change minimally at
 * cutover. Browser-only.
 */

import type {
  BuildCheckpoint,
  BuildFileRecord,
  BuildMemoryRecord,
  BuildMemoryStatus,
  ContextBlob,
  CustomModel,
  Discussion,
  FinalResult,
  GameSessionRecord,
  GenericGameMatchRecord,
  Message,
  ModelBuildStat,
  ProviderKey,
  UserSettings,
} from "@/lib/db/schema";
import type {
  BenchmarkArtifact,
  BenchmarkAttempt,
  BenchmarkAttemptV2,
  BenchmarkCase,
  BenchmarkCaseV2,
  BenchmarkFailure,
  BenchmarkMetricValue,
  BenchmarkModelCallTrace,
  BenchmarkRunEvent,
  BenchmarkRun,
  BenchmarkSuite,
  BenchmarkTeamComposition,
  BenchmarkToolCallTrace,
  BenchmarkVerifierResult,
  BenchmarkReportBundleV2,
  HarnessCertificationResult,
} from "@/lib/benchmark/types";
import type { AttachmentRecord } from "@/lib/attachments/types";
import {
  DISCUSSION_FILE_PATHS,
  createAdapter,
  getStorageConfig,
  setStorageConfig,
  type StorageAdapter,
  type StorageConfig,
} from "./storage-adapter";
import {
  isUnlocked,
  lock as lockCrypto,
  parseEnvelope,
  setPassphrase as setCryptoPassphrase,
  unlock as unlockCrypto,
  unwrap,
  wrap,
} from "./crypto-box";
import {
  isActiveBuildMemory,
  mergeBuildMemoryRecord,
  rekeyBuildMemoryRecord,
} from "@/lib/build-context/memory-store";
import {
  mergeModelStatsRecord,
  normalizeModelStat,
  type ModelStatDelta,
} from "@/lib/client/model-stats";

export interface ClientStore {
  userSettings: UserSettings;
  providerKeys: ProviderKey[];
  customModels: CustomModel[];
  discussions: Discussion[];
  messages: Message[];
  finalResults: FinalResult[];
  attachments: AttachmentRecord[];
  buildFiles: BuildFileRecord[];
  buildCheckpoints: BuildCheckpoint[];
  contextBlobs: ContextBlob[];
  buildMemories: BuildMemoryRecord[];
  gameSessions: GameSessionRecord[];
  gameMatchRecords: GenericGameMatchRecord[];
  gameStatsLegacyImportAttempted: boolean;
  benchmarkSuites: BenchmarkSuite[];
  benchmarkRuns: BenchmarkRun[];
  benchmarkCases: BenchmarkCase[];
  benchmarkCaseV2: BenchmarkCaseV2[];
  benchmarkAttempts: BenchmarkAttempt[];
  benchmarkAttemptsV2: BenchmarkAttemptV2[];
  benchmarkMetricValues: BenchmarkMetricValue[];
  benchmarkArtifacts: BenchmarkArtifact[];
  benchmarkFailures: BenchmarkFailure[];
  benchmarkTraces: BenchmarkModelCallTrace[];
  benchmarkRunEvents: BenchmarkRunEvent[];
  benchmarkToolCallTraces: BenchmarkToolCallTrace[];
  benchmarkVerifierResults: BenchmarkVerifierResult[];
  benchmarkTeamCompositions: BenchmarkTeamComposition[];
  benchmarkHarnessCertifications: HarnessCertificationResult[];
  /** Global per-model Build performance, accumulated across all builds. */
  modelStats: ModelBuildStat[];
}

type DiscussionOwnedKey =
  | "messages"
  | "finalResults"
  | "attachments"
  | "buildFiles"
  | "buildCheckpoints"
  | "contextBlobs";

type PersistedMainStore = Omit<ClientStore, DiscussionOwnedKey> & {
  storageSchemaVersion: 2;
  discussionStorage: {
    version: 1;
    migratedAt?: string;
  };
  messages: [];
  finalResults: [];
  attachments: AttachmentRecord[];
  buildFiles: [];
  buildCheckpoints: [];
  contextBlobs: [];
};

interface DiscussionStorageBundle {
  version: 1;
  discussionId: string;
  discussion: Discussion;
  messages: Message[];
  finalResult: FinalResult | null;
  attachments: AttachmentRecord[];
  buildFiles: BuildFileRecord[];
  buildCheckpoint: BuildCheckpoint | null;
  contextBlobs: ContextBlob[];
  updatedAt: string;
}

const DEFAULT_STORE: ClientStore = {
  userSettings: {
    id: "default",
    defaultEffort: "medium",
    defaultMode: "panel",
    judgeModelId: null,
    defaultVerbosity: "balanced",
    defaultStyleNote: "",
    defaultReasoningEffort: "default",
    defaultBuildRunPolicy: "finish",
    defaultBuildSkillMode: "balanced",
    defaultBuildBudgetUsd: 0,
    defaultBuildTimeLimitMinutes: 120,
    modelContextOverrides: {},
  },
  providerKeys: [],
  customModels: [],
  discussions: [],
  messages: [],
  finalResults: [],
  attachments: [],
  buildFiles: [],
  buildCheckpoints: [],
  contextBlobs: [],
  buildMemories: [],
  gameSessions: [],
  gameMatchRecords: [],
  gameStatsLegacyImportAttempted: false,
  benchmarkSuites: [],
  benchmarkRuns: [],
  benchmarkCases: [],
  benchmarkCaseV2: [],
  benchmarkAttempts: [],
  benchmarkAttemptsV2: [],
  benchmarkMetricValues: [],
  benchmarkArtifacts: [],
  benchmarkFailures: [],
  benchmarkTraces: [],
  benchmarkRunEvents: [],
  benchmarkToolCallTraces: [],
  benchmarkVerifierResults: [],
  benchmarkTeamCompositions: [],
  benchmarkHarnessCertifications: [],
  modelStats: [],
};

const BENCHMARK_STORE_KEYS = [
  "benchmarkSuites",
  "benchmarkRuns",
  "benchmarkCases",
  "benchmarkCaseV2",
  "benchmarkAttempts",
  "benchmarkAttemptsV2",
  "benchmarkMetricValues",
  "benchmarkArtifacts",
  "benchmarkFailures",
  "benchmarkTraces",
  "benchmarkRunEvents",
  "benchmarkToolCallTraces",
  "benchmarkVerifierResults",
  "benchmarkTeamCompositions",
  "benchmarkHarnessCertifications",
] as const;

type BenchmarkStoreKey = (typeof BENCHMARK_STORE_KEYS)[number];
type BenchmarkStoreFields = Pick<ClientStore, BenchmarkStoreKey>;

function hydrateStore(data: Partial<ClientStore> = {}): ClientStore {
  return { ...structuredClone(DEFAULT_STORE), ...data };
}

function emptyBenchmarkStoreFields(): BenchmarkStoreFields {
  return {
    benchmarkSuites: [],
    benchmarkRuns: [],
    benchmarkCases: [],
    benchmarkCaseV2: [],
    benchmarkAttempts: [],
    benchmarkAttemptsV2: [],
    benchmarkMetricValues: [],
    benchmarkArtifacts: [],
    benchmarkFailures: [],
    benchmarkTraces: [],
    benchmarkRunEvents: [],
    benchmarkToolCallTraces: [],
    benchmarkVerifierResults: [],
    benchmarkTeamCompositions: [],
    benchmarkHarnessCertifications: [],
  };
}

function stripBenchmarkStoreFields(data: Partial<ClientStore>): Partial<ClientStore> {
  const stripped = { ...data };
  for (const key of BENCHMARK_STORE_KEYS) delete stripped[key];
  return stripped;
}

const DISCUSSION_OWNED_STORE_KEYS = [
  "messages",
  "finalResults",
  "attachments",
  "buildFiles",
  "buildCheckpoints",
  "contextBlobs",
] as const;

function hasDiscussionOwnedStoreFields(data: Partial<ClientStore>): boolean {
  return DISCUSSION_OWNED_STORE_KEYS.some((key) => {
    const value = data[key];
    return Array.isArray(value) && value.length > 0;
  });
}

function referencedAttachmentIds(data: ClientStore): Set<string> {
  const ids = new Set<string>();
  for (const discussion of data.discussions) {
    for (const id of parseJsonStringArray(discussion.attachmentIds)) {
      ids.add(id);
    }
  }
  return ids;
}

function clientStoreForMainPersistence(data: ClientStore): PersistedMainStore {
  const referencedIds = referencedAttachmentIds(data);
  const mainStore: PersistedMainStore = {
    ...structuredClone(data),
    ...emptyBenchmarkStoreFields(),
    storageSchemaVersion: 2 as const,
    discussionStorage: {
      version: 1 as const,
    },
    messages: [],
    finalResults: [],
    attachments: data.attachments.filter((attachment) => !referencedIds.has(attachment.id)),
    buildFiles: [],
    buildCheckpoints: [],
    contextBlobs: [],
  };
  return mainStore;
}

function parseJsonStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function discussionBundleForPersistence(
  data: ClientStore,
  discussion: Discussion
): DiscussionStorageBundle {
  const attachmentIds = new Set(parseJsonStringArray(discussion.attachmentIds));
  return {
    version: 1,
    discussionId: discussion.id,
    discussion: structuredClone(discussion),
    messages: data.messages.filter((message) => message.discussionId === discussion.id),
    finalResult:
      data.finalResults.find((result) => result.discussionId === discussion.id) ?? null,
    attachments: data.attachments.filter((attachment) => attachmentIds.has(attachment.id)),
    buildFiles: data.buildFiles.filter((file) => file.discussionId === discussion.id),
    buildCheckpoint:
      (data.buildCheckpoints ?? []).find(
        (checkpoint) => checkpoint.discussionId === discussion.id
      ) ?? null,
    contextBlobs: (data.contextBlobs ?? []).filter(
      (blob) => blob.discussionId === discussion.id
    ),
    updatedAt: new Date().toISOString(),
  };
}

function hasBenchmarkStoreFields(data: Partial<ClientStore>): boolean {
  return BENCHMARK_STORE_KEYS.some((key) => {
    const value = data[key];
    return Array.isArray(value) && value.length > 0;
  });
}

function mergeBenchmarkStoreFields(
  target: ClientStore,
  source: Partial<BenchmarkStoreFields>
): ClientStore {
  return {
    ...target,
    benchmarkSuites: mergeById(target.benchmarkSuites, source.benchmarkSuites ?? []),
    benchmarkRuns: mergeById(target.benchmarkRuns, source.benchmarkRuns ?? []),
    benchmarkCases: mergeById(target.benchmarkCases, source.benchmarkCases ?? []),
    benchmarkCaseV2: mergeById(target.benchmarkCaseV2, source.benchmarkCaseV2 ?? []),
    benchmarkAttempts: mergeById(
      target.benchmarkAttempts,
      source.benchmarkAttempts ?? []
    ),
    benchmarkAttemptsV2: mergeById(
      target.benchmarkAttemptsV2,
      source.benchmarkAttemptsV2 ?? []
    ),
    benchmarkMetricValues: mergeById(
      target.benchmarkMetricValues,
      source.benchmarkMetricValues ?? []
    ),
    benchmarkArtifacts: mergeById(
      target.benchmarkArtifacts,
      source.benchmarkArtifacts ?? []
    ),
    benchmarkFailures: mergeById(
      target.benchmarkFailures,
      source.benchmarkFailures ?? []
    ),
    benchmarkTraces: mergeById(target.benchmarkTraces, source.benchmarkTraces ?? []),
    benchmarkRunEvents: mergeById(
      target.benchmarkRunEvents,
      source.benchmarkRunEvents ?? []
    ),
    benchmarkToolCallTraces: mergeById(
      target.benchmarkToolCallTraces,
      source.benchmarkToolCallTraces ?? []
    ),
    benchmarkVerifierResults: mergeById(
      target.benchmarkVerifierResults,
      source.benchmarkVerifierResults ?? []
    ),
    benchmarkTeamCompositions: mergeById(
      target.benchmarkTeamCompositions,
      source.benchmarkTeamCompositions ?? []
    ),
    benchmarkHarnessCertifications: mergeById(
      target.benchmarkHarnessCertifications,
      source.benchmarkHarnessCertifications ?? []
    ),
  };
}

function mergeById<T extends { id: string }>(left: T[], right: T[]): T[] {
  const records = new Map(left.map((item) => [item.id, item]));
  for (const item of right) records.set(item.id, item);
  return Array.from(records.values());
}

let memory: ClientStore | null = null;
let adapter: StorageAdapter | null = null;
let config: StorageConfig = { kind: "indexeddb", encryptionEnabled: false };
let initPromise: Promise<{ needsPassphrase: boolean }> | null = null;
let initGeneration = 0;
const readyListeners = new Set<() => void>();
let benchmarkRunBlobStorageForTests: Map<string, string> | null = null;
const pendingDeletedDiscussionIds = new Set<string>();

/**
 * Run-file ids already merged into `memory`. Populated during init and by
 * rescanBenchmarkRunFiles(); lets a rescan skip files it has already folded in
 * so a double rescan does not re-merge (and attempt counts stay stable).
 */
const mergedBenchmarkRunIds = new Set<string>();
/** Corrupt run-file ids already warned about, so we warn at most once per id per session. */
const corruptBenchmarkRunIds = new Set<string>();

export function isInitialized(): boolean {
  return memory !== null;
}

export function getConfig(): StorageConfig {
  return config;
}

/** Load config + adapter + store. Returns needsPassphrase=true if encrypted and locked. */
export async function initStore(): Promise<{ needsPassphrase: boolean }> {
  if (memory && adapter) return flushDirtyStoreIfReady();
  if (initPromise) return initPromise;

  const generation = initGeneration;
  initPromise = (memory ? initializeAdapterForMemory() : loadStore(generation)).finally(() => {
    initPromise = null;
  });
  return initPromise;
}

async function initializeAdapterForMemory(): Promise<{ needsPassphrase: boolean }> {
  config = await getStorageConfig();
  adapter = await createAdapter(config);
  return flushDirtyStoreIfReady();
}

async function flushDirtyStoreIfReady(): Promise<{ needsPassphrase: boolean }> {
  if (!persistDirty) return { needsPassphrase: false };
  if (config.encryptionEnabled && !isUnlocked()) return { needsPassphrase: true };
  await flush();
  return { needsPassphrase: false };
}

async function loadStore(generation: number): Promise<{ needsPassphrase: boolean }> {
  config = await getStorageConfig();
  adapter = await createAdapter(config);
  schedulePendingPersistIfReady();
  const raw = await adapter.load();

  if (raw === null) {
    const benchmarkData = await loadBenchmarkStoreFields();
    const loaded = await loadDiscussionStoreFields(hydrateStore());
    commitLoadedStore(generation, mergeBenchmarkStoreFields(loaded, benchmarkData));
    return { needsPassphrase: false };
  }

  const env = parseEnvelope(raw);
  if (!env) {
    const persisted = JSON.parse(raw) as Partial<ClientStore>;
    const hadLegacyBenchmarkData = hasBenchmarkStoreFields(persisted);
    const hadLegacyDiscussionData = hasDiscussionOwnedStoreFields(persisted);
    const benchmarkData = await loadBenchmarkStoreFields();
    const loaded = await loadDiscussionStoreFields(
      hydrateStore(stripBenchmarkStoreFields(persisted))
    );
    commitLoadedStore(
      generation,
      mergeBenchmarkStoreFields(loaded, benchmarkData)
    );
    if (hadLegacyBenchmarkData || hadLegacyDiscussionData) schedulePersist();
    return { needsPassphrase: false };
  }
  if (env.encrypted && !isUnlocked()) {
    return { needsPassphrase: true };
  }
  const json = await unwrap(env);
  const persisted = JSON.parse(json) as Partial<ClientStore>;
  const hadLegacyBenchmarkData = hasBenchmarkStoreFields(persisted);
  const hadLegacyDiscussionData = hasDiscussionOwnedStoreFields(persisted);
  const benchmarkData = await loadBenchmarkStoreFields();
  const loaded = await loadDiscussionStoreFields(
    hydrateStore(stripBenchmarkStoreFields(persisted))
  );
  commitLoadedStore(
    generation,
    mergeBenchmarkStoreFields(loaded, benchmarkData)
  );
  if (hadLegacyBenchmarkData || hadLegacyDiscussionData) schedulePersist();
  return { needsPassphrase: false };
}

function commitLoadedStore(generation: number, loaded: ClientStore): void {
  if (generation !== initGeneration || memory) return;
  memory = loaded;
  notifyReady();
}

async function loadDiscussionStoreFields(base: ClientStore): Promise<ClientStore> {
  if (!adapter) return base;
  const loaded = structuredClone(base);
  const ids = new Set(base.discussions.map((discussion) => discussion.id));
  for (const id of await adapter.listDiscussionIds()) ids.add(id);

  for (const id of ids) {
    const bundle = await loadDiscussionBundle(id);
    if (!bundle) continue;
    mergeDiscussionBundle(loaded, bundle);
  }
  return loaded;
}

async function loadDiscussionBundle(
  discussionId: string
): Promise<DiscussionStorageBundle | null> {
  if (!adapter) return null;
  const currentAdapter = adapter;
  try {
    const [
      discussionRaw,
      messagesRaw,
      finalRaw,
      attachmentsRaw,
      buildFilesRaw,
      checkpointRaw,
      contextBlobsRaw,
    ] = await Promise.all(
      DISCUSSION_FILE_PATHS.map((relativePath) =>
        currentAdapter.loadDiscussionFile(discussionId, relativePath)
      )
    );
    if (
      !discussionRaw &&
      !messagesRaw &&
      !finalRaw &&
      !attachmentsRaw &&
      !buildFilesRaw &&
      !checkpointRaw &&
      !contextBlobsRaw
    ) {
      return null;
    }
    const discussionRecord = discussionRaw
      ? (JSON.parse(discussionRaw) as { discussion?: Discussion } | Discussion)
      : null;
    const discussion =
      discussionRecord && "discussion" in discussionRecord
        ? discussionRecord.discussion
        : (discussionRecord as Discussion | null);
    if (!discussion) {
      console.warn(`Discussion "${discussionId}" has storage files but no discussion.json.`);
      return null;
    }
    return {
      version: 1,
      discussionId,
      discussion,
      messages: messagesRaw ? (JSON.parse(messagesRaw) as Message[]) : [],
      finalResult: finalRaw ? (JSON.parse(finalRaw) as FinalResult | null) : null,
      attachments: attachmentsRaw
        ? (JSON.parse(attachmentsRaw) as AttachmentRecord[])
        : [],
      buildFiles: buildFilesRaw ? (JSON.parse(buildFilesRaw) as BuildFileRecord[]) : [],
      buildCheckpoint: checkpointRaw
        ? (JSON.parse(checkpointRaw) as BuildCheckpoint | null)
        : null,
      contextBlobs: contextBlobsRaw
        ? (JSON.parse(contextBlobsRaw) as ContextBlob[])
        : [],
      updatedAt:
        "updatedAt" in (discussionRecord ?? {})
          ? String((discussionRecord as { updatedAt?: string }).updatedAt)
          : new Date().toISOString(),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Discussion "${discussionId}" could not be read: ${reason}`);
    return null;
  }
}

function mergeDiscussionBundle(target: ClientStore, bundle: DiscussionStorageBundle): void {
  upsertArrayByKey(target.discussions, bundle.discussion, (item) => item.id);
  target.messages = mergeById(target.messages, bundle.messages);
  target.finalResults = [
    ...target.finalResults.filter((item) => item.discussionId !== bundle.discussionId),
    ...(bundle.finalResult ? [bundle.finalResult] : []),
  ];
  target.attachments = mergeById(target.attachments, bundle.attachments);
  target.buildFiles = mergeBuildFiles(target.buildFiles, bundle.buildFiles);
  target.buildCheckpoints = [
    ...(target.buildCheckpoints ?? []).filter(
      (item) => item.discussionId !== bundle.discussionId
    ),
    ...(bundle.buildCheckpoint ? [bundle.buildCheckpoint] : []),
  ];
  target.contextBlobs = mergeById(target.contextBlobs ?? [], bundle.contextBlobs);
}

function upsertArrayByKey<T>(
  records: T[],
  record: T,
  keyFor: (record: T) => string
): void {
  const key = keyFor(record);
  const existing = records.findIndex((item) => keyFor(item) === key);
  if (existing >= 0) records[existing] = record;
  else records.push(record);
}

function mergeBuildFiles(
  left: BuildFileRecord[],
  right: BuildFileRecord[]
): BuildFileRecord[] {
  const records = new Map(
    left.map((item) => [`${item.discussionId}:${item.path}`, item])
  );
  for (const item of right) records.set(`${item.discussionId}:${item.path}`, item);
  return Array.from(records.values());
}

async function loadBenchmarkStoreFields(): Promise<BenchmarkStoreFields> {
  const fields = emptyBenchmarkStoreFields();
  mergedBenchmarkRunIds.clear();
  corruptBenchmarkRunIds.clear();
  const runIds = await listBenchmarkRunFileIds();
  for (const runId of runIds) {
    const bundle = await loadBenchmarkRunBundle(runId);
    if (bundle === CORRUPT_BENCHMARK_RUN) {
      // A corrupt benchmark run file must not block app startup; it is counted
      // and surfaced instead of silently swallowed.
      continue;
    }
    if (bundle === null) continue;
    mergeBenchmarkBundleIntoFields(fields, bundle);
    mergedBenchmarkRunIds.add(runId);
  }
  return fields;
}

/** Sentinel distinguishing a corrupt/unreadable run blob from a genuinely empty one. */
const CORRUPT_BENCHMARK_RUN = Symbol("corrupt-benchmark-run");

/** Lists run-file ids from the active source (test map or storage adapter). */
async function listBenchmarkRunFileIds(): Promise<string[]> {
  if (benchmarkRunBlobStorageForTests) {
    return Array.from(benchmarkRunBlobStorageForTests.keys());
  }
  if (!adapter) return [];
  return adapter.listBenchmarkRunIds();
}

/**
 * Loads and parses one run blob. Returns the parsed bundle, `null` when the
 * blob is absent, or the CORRUPT sentinel when it cannot be read/parsed (which
 * is warned about once per id per session).
 */
async function loadBenchmarkRunBundle(
  runId: string
): Promise<Partial<BenchmarkReportBundleV2> | null | typeof CORRUPT_BENCHMARK_RUN> {
  try {
    const raw = benchmarkRunBlobStorageForTests
      ? benchmarkRunBlobStorageForTests.get(runId) ?? null
      : adapter
        ? await adapter.loadBenchmarkRun(runId)
        : null;
    if (!raw) return null;
    const plaintext = await unwrapBenchmarkBlob(raw);
    return JSON.parse(plaintext) as Partial<BenchmarkReportBundleV2>;
  } catch (error) {
    warnCorruptBenchmarkRun(runId, error);
    return CORRUPT_BENCHMARK_RUN;
  }
}

function warnCorruptBenchmarkRun(runId: string, error: unknown): void {
  if (corruptBenchmarkRunIds.has(runId)) return;
  corruptBenchmarkRunIds.add(runId);
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`Benchmark run file "${runId}" could not be read: ${reason}`);
}

async function unwrapBenchmarkBlob(raw: string): Promise<string> {
  const env = parseEnvelope(raw);
  return env ? await unwrap(env) : raw;
}

export interface BenchmarkRunRescanResult {
  /** Run files newly merged into memory by this rescan. */
  merged: number;
  /** Run files present but unreadable/corrupt (skipped). */
  corrupt: number;
}

/**
 * Re-lists benchmark run files and merges any that appeared AFTER init (another
 * tab, a cloud-synced folder, or an external writer) into the in-memory store.
 *
 * Scope: new-ids-only. Files already merged (tracked in `mergedBenchmarkRunIds`)
 * are skipped, so a double rescan does not re-merge and record counts stay
 * stable. A run file whose contents changed in place after being merged is NOT
 * re-read here — in-app writers merge their own edits into memory directly, and
 * detecting external in-place edits would require per-file hashing on every
 * refresh. `corrupt` counts files that could not be read this session.
 */
export async function rescanBenchmarkRunFiles(): Promise<BenchmarkRunRescanResult> {
  if (!memory) return { merged: 0, corrupt: corruptBenchmarkRunIds.size };
  const runIds = await listBenchmarkRunFileIds();
  let merged = 0;
  for (const runId of runIds) {
    if (mergedBenchmarkRunIds.has(runId)) continue;
    const bundle = await loadBenchmarkRunBundle(runId);
    if (bundle === CORRUPT_BENCHMARK_RUN || bundle === null) continue;
    const fields = emptyBenchmarkStoreFields();
    mergeBenchmarkBundleIntoFields(fields, bundle);
    memory = mergeBenchmarkStoreFields(memory, fields);
    mergedBenchmarkRunIds.add(runId);
    merged += 1;
  }
  return { merged, corrupt: corruptBenchmarkRunIds.size };
}

/**
 * Count of benchmark run files that could not be read this session. The
 * dashboard surfaces this so silently unreadable evidence is visible.
 */
export function getCorruptBenchmarkRunCount(): number {
  return corruptBenchmarkRunIds.size;
}

function mergeBenchmarkBundleIntoFields(
  fields: BenchmarkStoreFields,
  bundle: Partial<BenchmarkReportBundleV2>
): void {
  fields.benchmarkSuites = mergeById(fields.benchmarkSuites, bundle.suites ?? []);
  fields.benchmarkRuns = mergeById(fields.benchmarkRuns, bundle.runs ?? []);
  fields.benchmarkCases = mergeById(fields.benchmarkCases, bundle.cases ?? []);
  fields.benchmarkAttempts = mergeById(
    fields.benchmarkAttempts,
    bundle.attempts ?? []
  );
  fields.benchmarkMetricValues = mergeById(
    fields.benchmarkMetricValues,
    bundle.metricValues ?? []
  );
  fields.benchmarkArtifacts = mergeById(
    fields.benchmarkArtifacts,
    bundle.artifacts ?? []
  );
  fields.benchmarkFailures = mergeById(
    fields.benchmarkFailures,
    bundle.failures ?? []
  );
  fields.benchmarkTraces = mergeById(fields.benchmarkTraces, bundle.traces ?? []);
  fields.benchmarkCaseV2 = mergeById(fields.benchmarkCaseV2, bundle.caseV2 ?? []);
  fields.benchmarkAttemptsV2 = mergeById(
    fields.benchmarkAttemptsV2,
    bundle.attemptsV2 ?? []
  );
  fields.benchmarkVerifierResults = mergeById(
    fields.benchmarkVerifierResults,
    bundle.verifierResults ?? []
  );
  fields.benchmarkRunEvents = mergeById(
    fields.benchmarkRunEvents,
    bundle.runEvents ?? []
  );
  fields.benchmarkToolCallTraces = mergeById(
    fields.benchmarkToolCallTraces,
    bundle.toolCallTraces ?? []
  );
  fields.benchmarkTeamCompositions = mergeById(
    fields.benchmarkTeamCompositions,
    bundle.teamCompositions ?? []
  );
  fields.benchmarkHarnessCertifications = mergeById(
    fields.benchmarkHarnessCertifications,
    bundle.harnessCertifications ?? []
  );
}

function notifyReadyListener(listener: () => void): void {
  try {
    listener();
  } catch {
    // Readiness listeners must not break store initialization.
  }
}

function notifyReady(): void {
  for (const listener of Array.from(readyListeners)) {
    notifyReadyListener(listener);
  }
}

export function onStoreReady(listener: () => void): () => void {
  readyListeners.add(listener);
  if (memory) {
    queueMicrotask(() => {
      if (readyListeners.has(listener) && memory) notifyReadyListener(listener);
    });
  }
  return () => {
    readyListeners.delete(listener);
  };
}

function store(): ClientStore {
  if (!memory) throw new Error("Client store not initialized");
  return memory;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistDirty = false;

// File System Access createWritable() is not safe for overlapping writes to the
// same file: a second write that starts before the first closes throws
// InvalidStateError ("...state had changed since it was read from disk"). The
// certified benchmark records traces/events concurrently (scenario-level
// parallelism), so two record saves can reach flush()/saveBenchmarkRun at once.
// Serialize every adapter write through one queue — concurrent callers are
// ordered, never overlapped. IndexedDB serializes via its own transactions, so
// this only matters for the folder adapter, but the queue is harmless there.
let adapterWriteQueue: Promise<unknown> = Promise.resolve();
function serializeAdapterWrite<T>(op: () => Promise<T>): Promise<T> {
  const result = adapterWriteQueue.then(op, op);
  // Keep the chain alive past individual failures; the caller still receives
  // this op's own rejection via `result`.
  adapterWriteQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function schedulePersist(): void {
  persistDirty = true;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => void flush(), 150);
}

function schedulePendingPersistIfReady(): void {
  if (memory && adapter && persistDirty) schedulePersist();
}

export async function flush(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!memory) {
    persistDirty = false;
    return;
  }
  if (!adapter) return;
  const currentAdapter = adapter;
  if (config.encryptionEnabled && !isUnlocked()) {
    persistDirty = true;
    return;
  }
  // Compute the envelope from the current memory snapshot BEFORE queueing the
  // write, so each serialized save persists the latest state (last-write-wins).
  const deletedDiscussionIds = Array.from(pendingDeletedDiscussionIds);
  pendingDeletedDiscussionIds.clear();
  for (const discussionId of deletedDiscussionIds) {
    await serializeAdapterWrite(() => currentAdapter.deleteDiscussion(discussionId));
  }
  for (const discussion of memory.discussions) {
    const bundle = discussionBundleForPersistence(memory, discussion);
    await persistDiscussionBundle(currentAdapter, bundle);
  }
  const env = await wrap(
    JSON.stringify(clientStoreForMainPersistence(memory)),
    config.encryptionEnabled
  );
  await serializeAdapterWrite(() => currentAdapter.save(JSON.stringify(env)));
  persistDirty = false;
}

async function persistDiscussionBundle(
  currentAdapter: StorageAdapter,
  bundle: DiscussionStorageBundle
): Promise<void> {
  await serializeAdapterWrite(() =>
    currentAdapter.saveDiscussionFile(
      bundle.discussionId,
      "discussion.json",
      JSON.stringify(
        {
          version: bundle.version,
          discussionId: bundle.discussionId,
          discussion: bundle.discussion,
          updatedAt: bundle.updatedAt,
        },
        null,
        2
      )
    )
  );
  await serializeAdapterWrite(() =>
    currentAdapter.saveDiscussionFile(
      bundle.discussionId,
      "messages.json",
      JSON.stringify(bundle.messages, null, 2)
    )
  );
  await serializeAdapterWrite(() =>
    currentAdapter.saveDiscussionFile(
      bundle.discussionId,
      "final-result.json",
      JSON.stringify(bundle.finalResult, null, 2)
    )
  );
  await serializeAdapterWrite(() =>
    currentAdapter.saveDiscussionFile(
      bundle.discussionId,
      "attachments.json",
      JSON.stringify(bundle.attachments, null, 2)
    )
  );
  await serializeAdapterWrite(() =>
    currentAdapter.saveDiscussionFile(
      bundle.discussionId,
      "build/files.json",
      JSON.stringify(bundle.buildFiles, null, 2)
    )
  );
  await serializeAdapterWrite(() =>
    currentAdapter.saveDiscussionFile(
      bundle.discussionId,
      "build/checkpoint.json",
      JSON.stringify(bundle.buildCheckpoint, null, 2)
    )
  );
  await serializeAdapterWrite(() =>
    currentAdapter.saveDiscussionFile(
      bundle.discussionId,
      "build/context-blobs.json",
      JSON.stringify(bundle.contextBlobs, null, 2)
    )
  );
}

// ── Reads (synchronous against memory) ────────────────────────────────────────

export function getUserSettings(): UserSettings {
  return store().userSettings;
}
export function getProviderKeys(): ProviderKey[] {
  return store().providerKeys;
}
export function getProviderKey(providerId: string): ProviderKey | undefined {
  return store().providerKeys.find((k) => k.providerId === providerId);
}
export function getCustomModels(): CustomModel[] {
  return store().customModels;
}
export function getCustomModelById(id: string): CustomModel | undefined {
  return store().customModels.find((m) => m.id === id);
}
export function listDiscussions(limit = 50): Discussion[] {
  return store().discussions.slice(0, limit);
}
export function getDiscussionById(id: string): Discussion | undefined {
  return store().discussions.find((d) => d.id === id);
}
export function getMessagesForDiscussion(id: string): Message[] {
  return store()
    .messages.filter((m) => m.discussionId === id)
    .sort((a, b) => a.round - b.round || a.createdAt.localeCompare(b.createdAt));
}
export function getFinalResult(id: string): FinalResult | undefined {
  return store().finalResults.find((r) => r.discussionId === id);
}
export function getAttachments(ids: string[]): AttachmentRecord[] {
  const s = store();
  return ids
    .map((id) => s.attachments.find((a) => a.id === id))
    .filter((a): a is AttachmentRecord => !!a);
}
export function getAttachment(id: string): AttachmentRecord | undefined {
  return store().attachments.find((a) => a.id === id);
}
export function getBuildFiles(discussionId: string): BuildFileRecord[] {
  return store().buildFiles.filter((f) => f.discussionId === discussionId);
}
export function getBuildCheckpoint(discussionId: string): BuildCheckpoint | undefined {
  return store().buildCheckpoints?.find((c) => c.discussionId === discussionId);
}
export function getBuildCheckpoints(): BuildCheckpoint[] {
  const s = store();
  s.buildCheckpoints ??= [];
  return s.buildCheckpoints;
}
export function getContextBlob(id: string): ContextBlob | undefined {
  return (store().contextBlobs ?? []).find((blob) => blob.id === id);
}
export function getContextBlobsForDiscussion(discussionId: string): ContextBlob[] {
  return (store().contextBlobs ?? []).filter(
    (blob) => blob.discussionId === discussionId
  );
}
export function getBuildMemory(id: string): BuildMemoryRecord | undefined {
  return (store().buildMemories ?? []).find((memory) => memory.id === id);
}
export function listBuildMemories(projectKey: string): BuildMemoryRecord[] {
  return (store().buildMemories ?? [])
    .filter((memory) => memory.projectKey === projectKey)
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}
export function listActiveBuildMemories(projectKey: string): BuildMemoryRecord[] {
  return listBuildMemories(projectKey).filter(isActiveBuildMemory);
}
export function getGameSessions(): GameSessionRecord[] {
  const s = store();
  s.gameSessions ??= [];
  return s.gameSessions;
}
export function getGenericGameMatchRecords(): GenericGameMatchRecord[] {
  const s = store();
  s.gameMatchRecords ??= [];
  return s.gameMatchRecords;
}
export function getBenchmarkSuites(): BenchmarkSuite[] {
  const s = store();
  s.benchmarkSuites ??= [];
  return s.benchmarkSuites;
}
export function getBenchmarkRuns(): BenchmarkRun[] {
  const s = store();
  s.benchmarkRuns ??= [];
  return s.benchmarkRuns;
}
export function getBenchmarkCases(): BenchmarkCase[] {
  const s = store();
  s.benchmarkCases ??= [];
  return s.benchmarkCases;
}
export function getBenchmarkCaseV2(): BenchmarkCaseV2[] {
  const s = store();
  s.benchmarkCaseV2 ??= [];
  return s.benchmarkCaseV2;
}
export function getBenchmarkAttempts(): BenchmarkAttempt[] {
  const s = store();
  s.benchmarkAttempts ??= [];
  return s.benchmarkAttempts;
}
export function getBenchmarkAttemptsV2(): BenchmarkAttemptV2[] {
  const s = store();
  s.benchmarkAttemptsV2 ??= [];
  return s.benchmarkAttemptsV2;
}
export function getBenchmarkMetricValues(): BenchmarkMetricValue[] {
  const s = store();
  s.benchmarkMetricValues ??= [];
  return s.benchmarkMetricValues;
}
export function getBenchmarkArtifacts(): BenchmarkArtifact[] {
  const s = store();
  s.benchmarkArtifacts ??= [];
  return s.benchmarkArtifacts;
}
export function getBenchmarkFailures(): BenchmarkFailure[] {
  const s = store();
  s.benchmarkFailures ??= [];
  return s.benchmarkFailures;
}
export function getBenchmarkTraces(): BenchmarkModelCallTrace[] {
  const s = store();
  s.benchmarkTraces ??= [];
  return s.benchmarkTraces;
}
export function getBenchmarkRunEvents(): BenchmarkRunEvent[] {
  const s = store();
  s.benchmarkRunEvents ??= [];
  return s.benchmarkRunEvents;
}
export function getBenchmarkToolCallTraces(): BenchmarkToolCallTrace[] {
  const s = store();
  s.benchmarkToolCallTraces ??= [];
  return s.benchmarkToolCallTraces;
}
export function getBenchmarkVerifierResults(): BenchmarkVerifierResult[] {
  const s = store();
  s.benchmarkVerifierResults ??= [];
  return s.benchmarkVerifierResults;
}
export function getBenchmarkTeamCompositions(): BenchmarkTeamComposition[] {
  const s = store();
  s.benchmarkTeamCompositions ??= [];
  return s.benchmarkTeamCompositions;
}
export function getBenchmarkHarnessCertifications(): HarnessCertificationResult[] {
  const s = store();
  s.benchmarkHarnessCertifications ??= [];
  return s.benchmarkHarnessCertifications;
}
export function hasAttemptedGameStatsLegacyImport(): boolean {
  return store().gameStatsLegacyImportAttempted ?? false;
}
export function getModelStats(): ModelBuildStat[] {
  return (store().modelStats ?? []).map(normalizeModelStat);
}
export function resetModelStats(modelId?: string): void {
  const s = store();
  s.modelStats = modelId
    ? (s.modelStats ?? []).filter((m) => m.modelId !== modelId)
    : [];
  schedulePersist();
}

// ── Writes (mutate memory, schedule persist) ──────────────────────────────────

export function insertDiscussion(d: Discussion): void {
  store().discussions.unshift(d);
  schedulePersist();
}
export function updateDiscussion(id: string, patch: Partial<Discussion>): void {
  const s = store();
  const i = s.discussions.findIndex((d) => d.id === id);
  if (i >= 0) {
    s.discussions[i] = { ...s.discussions[i], ...patch };
    schedulePersist();
  }
}
export function deleteDiscussion(id: string): void {
  const s = store();
  const discussion = s.discussions.find((d) => d.id === id);
  const removedAttachmentIds = new Set(parseJsonStringArray(discussion?.attachmentIds));
  s.discussions = s.discussions.filter((d) => d.id !== id);
  s.messages = s.messages.filter((m) => m.discussionId !== id);
  s.finalResults = s.finalResults.filter((r) => r.discussionId !== id);
  s.buildFiles = s.buildFiles.filter((f) => f.discussionId !== id);
  s.buildCheckpoints = (s.buildCheckpoints ?? []).filter(
    (c) => c.discussionId !== id
  );
  s.contextBlobs = (s.contextBlobs ?? []).filter(
    (blob) => blob.discussionId !== id
  );
  s.buildMemories = (s.buildMemories ?? []).filter(
    (memory) => memory.discussionId !== id
  );
  const stillReferencedAttachmentIds = referencedAttachmentIds(s);
  s.attachments = s.attachments.filter(
    (attachment) =>
      !removedAttachmentIds.has(attachment.id) ||
      stillReferencedAttachmentIds.has(attachment.id)
  );
  pendingDeletedDiscussionIds.add(id);
  schedulePersist();
}
/**
 * Fold one build's per-worker results into the global per-model stats. The
 * per-record arithmetic (including legacy-field normalization and token-total
 * summing) lives in {@link mergeModelStatsRecord} so it stays testable without
 * the store; this wrapper only handles find/insert and persistence.
 */
export function accumulateModelStats(input: {
  judgeModelId: string;
  workers: ModelStatDelta[];
}): void {
  const s = store();
  if (!s.modelStats) s.modelStats = []; // stores persisted before this field existed
  const now = new Date().toISOString();
  for (const d of input.workers) {
    if (d.attempts <= 0) continue;
    const prev = s.modelStats.find((m) => m.modelId === d.modelId);
    const merged = mergeModelStatsRecord(prev, d, input.judgeModelId, now);
    if (prev) s.modelStats[s.modelStats.indexOf(prev)] = merged;
    else s.modelStats.push(merged);
  }
  schedulePersist();
}

export function upsertBuildFile(rec: BuildFileRecord): void {
  const s = store();
  const i = s.buildFiles.findIndex(
    (f) => f.discussionId === rec.discussionId && f.path === rec.path
  );
  if (i >= 0) s.buildFiles[i] = rec;
  else s.buildFiles.push(rec);
  schedulePersist();
}
export function upsertBuildCheckpoint(checkpoint: BuildCheckpoint): void {
  const s = store();
  if (!s.buildCheckpoints) s.buildCheckpoints = [];
  const i = s.buildCheckpoints.findIndex(
    (c) => c.discussionId === checkpoint.discussionId
  );
  if (i >= 0) s.buildCheckpoints[i] = checkpoint;
  else s.buildCheckpoints.push(checkpoint);
  schedulePersist();
}
export function upsertContextBlob(blob: ContextBlob): void {
  const s = store();
  if (!s.contextBlobs) s.contextBlobs = [];
  const existing = s.contextBlobs.findIndex((item) => item.id === blob.id);
  if (existing >= 0) s.contextBlobs[existing] = blob;
  else s.contextBlobs.push(blob);
  schedulePersist();
}
export function upsertBuildMemory(record: BuildMemoryRecord): void {
  if (record.evidence.length === 0) return;
  const s = store();
  if (!s.buildMemories) s.buildMemories = [];
  const existing = s.buildMemories.findIndex((item) => item.id === record.id);
  if (existing >= 0) {
    s.buildMemories[existing] = mergeBuildMemoryRecord(
      s.buildMemories[existing],
      record
    );
  } else {
    s.buildMemories.push(record);
  }
  enforceBuildMemoryCap(s);
  schedulePersist();
}

function enforceBuildMemoryCap(s: ClientStore): void {
  if ((s.buildMemories ?? []).length > 500) {
    s.buildMemories = s.buildMemories
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .slice(0, 500);
  }
}
export function updateBuildMemoryStatus(
  id: string,
  status: BuildMemoryStatus
): void {
  const s = store();
  if (!s.buildMemories) s.buildMemories = [];
  const existing = s.buildMemories.findIndex((item) => item.id === id);
  if (existing < 0) return;
  s.buildMemories[existing] = {
    ...s.buildMemories[existing],
    status,
    updatedAt: new Date().toISOString(),
  };
  schedulePersist();
}
export function migrateBuildMemoriesProjectKey(
  oldProjectKey: string,
  newProjectKey: string
): void {
  if (!oldProjectKey || !newProjectKey || oldProjectKey === newProjectKey) return;
  const s = store();
  if (!s.buildMemories) s.buildMemories = [];
  const moving = s.buildMemories.filter(
    (memory) => memory.projectKey === oldProjectKey
  );
  if (moving.length === 0) return;
  s.buildMemories = s.buildMemories.filter(
    (memory) => memory.projectKey !== oldProjectKey
  );
  for (const memory of moving) {
    const rekeyed = rekeyBuildMemoryRecord(memory, newProjectKey);
    const existing = s.buildMemories.findIndex((item) => item.id === rekeyed.id);
    if (existing >= 0) {
      s.buildMemories[existing] = mergeBuildMemoryRecord(
        s.buildMemories[existing],
        rekeyed
      );
    } else {
      s.buildMemories.push(rekeyed);
    }
  }
  enforceBuildMemoryCap(s);
  schedulePersist();
}
export function deleteBuildCheckpoint(discussionId: string): void {
  const s = store();
  s.buildCheckpoints = (s.buildCheckpoints ?? []).filter(
    (c) => c.discussionId !== discussionId
  );
  schedulePersist();
}
export function upsertGameSession(record: GameSessionRecord): void {
  const list = getGameSessions();
  const i = list.findIndex((s) => s.id === record.id);
  if (i >= 0) list[i] = record;
  else list.push(record);
  schedulePersist();
}
export function deleteGameSession(id: string): void {
  const s = store();
  s.gameSessions = (s.gameSessions ?? []).filter((session) => session.id !== id);
  schedulePersist();
}
export function saveGenericGameMatchRecord(record: GenericGameMatchRecord): void {
  getGenericGameMatchRecords().push(record);
  schedulePersist();
}
function upsertById<T extends { id: string }>(records: T[], record: T): void {
  const i = records.findIndex((item) => item.id === record.id);
  if (i >= 0) records[i] = record;
  else records.push(record);
}

function removeWhere<T>(records: T[], predicate: (record: T) => boolean): number {
  let removed = 0;
  for (let index = records.length - 1; index >= 0; index--) {
    if (predicate(records[index])) {
      records.splice(index, 1);
      removed++;
    }
  }
  if (removed > 0) schedulePersist();
  return removed;
}

export function upsertBenchmarkSuite(record: BenchmarkSuite): void {
  upsertById(getBenchmarkSuites(), record);
  schedulePersist();
}
export function upsertBenchmarkRun(record: BenchmarkRun): void {
  upsertById(getBenchmarkRuns(), record);
  schedulePersist();
}
export function upsertBenchmarkCase(record: BenchmarkCase): void {
  upsertById(getBenchmarkCases(), record);
  schedulePersist();
}
export function upsertBenchmarkCaseV2(record: BenchmarkCaseV2): void {
  upsertById(getBenchmarkCaseV2(), record);
  schedulePersist();
}
export function upsertBenchmarkAttempt(record: BenchmarkAttempt): void {
  upsertById(getBenchmarkAttempts(), record);
  schedulePersist();
}
export function upsertBenchmarkAttemptV2(record: BenchmarkAttemptV2): void {
  upsertById(getBenchmarkAttemptsV2(), record);
  schedulePersist();
}
export function upsertBenchmarkMetricValue(record: BenchmarkMetricValue): void {
  upsertById(getBenchmarkMetricValues(), record);
  schedulePersist();
}
export function upsertBenchmarkArtifact(record: BenchmarkArtifact): void {
  upsertById(getBenchmarkArtifacts(), record);
  schedulePersist();
}
export function upsertBenchmarkFailure(record: BenchmarkFailure): void {
  upsertById(getBenchmarkFailures(), record);
  schedulePersist();
}
export function upsertBenchmarkTrace(record: BenchmarkModelCallTrace): void {
  upsertById(getBenchmarkTraces(), record);
  schedulePersist();
}
export function upsertBenchmarkRunEvent(record: BenchmarkRunEvent): void {
  upsertById(getBenchmarkRunEvents(), record);
  schedulePersist();
}
export function upsertBenchmarkToolCallTrace(record: BenchmarkToolCallTrace): void {
  upsertById(getBenchmarkToolCallTraces(), record);
  schedulePersist();
}
export function upsertBenchmarkVerifierResult(
  record: BenchmarkVerifierResult
): void {
  upsertById(getBenchmarkVerifierResults(), record);
  schedulePersist();
}
export function upsertBenchmarkTeamComposition(
  record: BenchmarkTeamComposition
): void {
  upsertById(getBenchmarkTeamCompositions(), record);
  schedulePersist();
}
export function upsertBenchmarkHarnessCertification(
  record: HarnessCertificationResult
): void {
  upsertById(getBenchmarkHarnessCertifications(), record);
  schedulePersist();
}
export function deleteBenchmarkRunById(runId: string): number {
  return removeWhere(getBenchmarkRuns(), (record) => record.id === runId);
}
export function deleteBenchmarkAttemptV2ById(attemptId: string): number {
  return removeWhere(getBenchmarkAttemptsV2(), (record) => record.id === attemptId);
}
export function deleteBenchmarkAttemptsV2ByRunId(runId: string): number {
  return removeWhere(getBenchmarkAttemptsV2(), (record) => record.runId === runId);
}
export function deleteBenchmarkArtifactsByIds(artifactIds: Iterable<string>): number {
  const ids = new Set(Array.from(artifactIds).filter(Boolean));
  if (ids.size === 0) return 0;
  return removeWhere(getBenchmarkArtifacts(), (record) => ids.has(record.id));
}
export function deleteBenchmarkArtifactsByAttemptId(attemptId: string): number {
  return removeWhere(
    getBenchmarkArtifacts(),
    (record) => record.attemptId === attemptId
  );
}
export function deleteBenchmarkArtifactsByRunId(runId: string): number {
  return removeWhere(getBenchmarkArtifacts(), (record) => record.runId === runId);
}
export function deleteBenchmarkVerifierResultsByAttemptId(
  attemptId: string
): number {
  return removeWhere(
    getBenchmarkVerifierResults(),
    (record) => record.attemptId === attemptId
  );
}
export function deleteBenchmarkFailuresByAttemptId(attemptId: string): number {
  return removeWhere(
    getBenchmarkFailures(),
    (record) => record.attemptId === attemptId
  );
}
export function deleteBenchmarkFailuresByRunId(runId: string): number {
  return removeWhere(getBenchmarkFailures(), (record) => record.runId === runId);
}
export function deleteBenchmarkTracesByAttemptId(attemptId: string): number {
  return removeWhere(getBenchmarkTraces(), (record) => record.attemptId === attemptId);
}
export function deleteBenchmarkTracesByRunId(runId: string): number {
  return removeWhere(getBenchmarkTraces(), (record) => record.runId === runId);
}
export function deleteBenchmarkRunEventsByAttemptId(attemptId: string): number {
  return removeWhere(
    getBenchmarkRunEvents(),
    (record) => record.attemptId === attemptId
  );
}
export function deleteBenchmarkToolCallTracesByAttemptId(
  attemptId: string
): number {
  return removeWhere(
    getBenchmarkToolCallTraces(),
    (record) => record.attemptId === attemptId
  );
}
export function markGameStatsLegacyImportAttempted(): void {
  store().gameStatsLegacyImportAttempted = true;
  schedulePersist();
}
/**
 * Wipe a discussion's run output (model messages, final result, persisted
 * build files) for a from-scratch restart. User notes are kept — the next run
 * still has to honor them. Files already written to disk are untouched.
 */
export function clearDiscussionRun(id: string): void {
  const s = store();
  s.messages = s.messages.filter(
    (m) => m.discussionId !== id || m.role === "user"
  );
  s.finalResults = s.finalResults.filter((r) => r.discussionId !== id);
  s.buildFiles = s.buildFiles.filter((f) => f.discussionId !== id);
  s.buildCheckpoints = (s.buildCheckpoints ?? []).filter(
    (c) => c.discussionId !== id
  );
  s.contextBlobs = (s.contextBlobs ?? []).filter(
    (blob) => blob.discussionId !== id
  );
  schedulePersist();
}
export function insertMessage(m: Message): void {
  store().messages.push(m);
  schedulePersist();
}
export function insertFinalResult(r: FinalResult): void {
  const s = store();
  const i = s.finalResults.findIndex((x) => x.discussionId === r.discussionId);
  if (i >= 0) s.finalResults[i] = r;
  else s.finalResults.push(r);
  schedulePersist();
}
export function upsertProviderKey(k: ProviderKey): void {
  const s = store();
  const i = s.providerKeys.findIndex((x) => x.providerId === k.providerId);
  if (i >= 0) s.providerKeys[i] = k;
  else s.providerKeys.push(k);
  schedulePersist();
}
export function updateProviderKey(
  providerId: string,
  patch: Partial<ProviderKey>
): void {
  const s = store();
  const i = s.providerKeys.findIndex((x) => x.providerId === providerId);
  if (i >= 0) {
    s.providerKeys[i] = { ...s.providerKeys[i], ...patch };
    schedulePersist();
  }
}
export function updateUserSettings(patch: Partial<UserSettings>): void {
  const s = store();
  s.userSettings = { ...s.userSettings, ...patch };
  schedulePersist();
}
export function addCustomModel(m: CustomModel): void {
  store().customModels.push(m);
  schedulePersist();
}
export function updateCustomModel(id: string, patch: Partial<CustomModel>): void {
  const s = store();
  const i = s.customModels.findIndex((x) => x.id === id);
  if (i >= 0) {
    s.customModels[i] = { ...s.customModels[i], ...patch };
    schedulePersist();
  }
}
export function deleteCustomModel(id: string): void {
  const s = store();
  s.customModels = s.customModels.filter((m) => m.id !== id);
  schedulePersist();
}
export function addAttachment(a: AttachmentRecord): void {
  store().attachments.push(a);
  schedulePersist();
}
export function deleteAttachmentRecord(id: string): void {
  const s = store();
  s.attachments = s.attachments.filter((a) => a.id !== id);
  schedulePersist();
}

// ── Import / export / config ──────────────────────────────────────────────────

/** Replace the whole store (used by the one-time import from the server). */
export function replaceStore(data: Partial<ClientStore>): void {
  initGeneration++;
  memory = hydrateStore(data);
  notifyReady();
  schedulePersist();
}

export function exportStore(): ClientStore {
  return store();
}

export async function saveBenchmarkRunBlob(
  runId: string,
  plaintextJson: string
): Promise<void> {
  // An in-app write already merged this run's records into memory, so mark it
  // merged: a later rescan must not re-count it as a newly discovered file.
  mergedBenchmarkRunIds.add(runId);
  corruptBenchmarkRunIds.delete(runId);
  if (benchmarkRunBlobStorageForTests) {
    benchmarkRunBlobStorageForTests.set(runId, plaintextJson);
    return;
  }
  if (!adapter) return;
  const currentAdapter = adapter;
  if (config.encryptionEnabled && !isUnlocked()) {
    throw new Error("Unlock storage before saving benchmark data.");
  }
  const blob = config.encryptionEnabled
    ? JSON.stringify(await wrap(plaintextJson, true))
    : plaintextJson;
  await serializeAdapterWrite(() => currentAdapter.saveBenchmarkRun(runId, blob));
}

export async function deleteBenchmarkRunBlob(runId: string): Promise<void> {
  mergedBenchmarkRunIds.delete(runId);
  corruptBenchmarkRunIds.delete(runId);
  if (benchmarkRunBlobStorageForTests) {
    benchmarkRunBlobStorageForTests.delete(runId);
    return;
  }
  if (!adapter) return;
  const currentAdapter = adapter;
  await serializeAdapterWrite(() => currentAdapter.deleteBenchmarkRun(runId));
}

export interface ClearAllBenchmarkDataResult {
  /** Per-run benchmark blob files deleted via the storage adapter. */
  runFiles: number;
  /** In-memory benchmark records (v1 + v2) removed across every array. */
  records: number;
}

/**
 * Wipe every benchmark record: all per-run blob files, the merged-run/corrupt
 * tracking, and every in-memory benchmark array (v1 lab records + v2 certified
 * records). Persists afterwards so a subsequent rescan resurrects nothing.
 *
 * Scope: benchmark evidence ONLY. Game sessions/match records, build
 * checkpoints/files/memories, model (Build Lab) stats, discussions/messages,
 * provider settings, and attachments are untouched.
 */
export async function clearAllBenchmarkData(): Promise<ClearAllBenchmarkDataResult> {
  const s = store();

  const records = BENCHMARK_STORE_KEYS.reduce(
    (sum, key) => sum + (s[key]?.length ?? 0),
    0
  );

  // Delete every run blob the adapter knows about (idb keys / FS run files).
  // Use the file ids straight from the source so orphaned blobs whose records
  // never merged (e.g. a corrupt file) are cleaned up too.
  const runFileIds = await listBenchmarkRunFileIds();
  let runFiles = 0;
  for (const runId of runFileIds) {
    await deleteBenchmarkRunBlob(runId);
    runFiles += 1;
  }

  // Empty every in-memory benchmark array in place so live references (the
  // `getBenchmark*` getters return the array itself) observe the clear.
  for (const key of BENCHMARK_STORE_KEYS) {
    (s[key] as unknown[]).length = 0;
  }

  // Belt and suspenders: drop any tracking for ids that were never files.
  mergedBenchmarkRunIds.clear();
  corruptBenchmarkRunIds.clear();

  schedulePersist();
  await flush();

  return { runFiles, records };
}

export function __enableBenchmarkRunBlobStorageForTests(): void {
  benchmarkRunBlobStorageForTests = new Map();
  mergedBenchmarkRunIds.clear();
  corruptBenchmarkRunIds.clear();
}

/** Test helper: inject (or clear) the storage adapter so tests can exercise the
 * real adapter-write path (e.g. write serialization) without a browser. */
export function __setAdapterForTests(next: StorageAdapter | null): void {
  adapter = next;
}

/** Test helper: writes a raw run blob directly, bypassing the in-app save path
 * (simulates a file that appeared after init, e.g. another tab / synced folder). */
export function __setBenchmarkRunBlobRawForTests(runId: string, raw: string): void {
  if (!benchmarkRunBlobStorageForTests) {
    benchmarkRunBlobStorageForTests = new Map();
  }
  benchmarkRunBlobStorageForTests.set(runId, raw);
}

export function __getBenchmarkRunBlobsForTests(): Record<string, string> {
  return Object.fromEntries(benchmarkRunBlobStorageForTests ?? []);
}

export function __exportClientStoreForPersistenceForTests(): ClientStore {
  return clientStoreForMainPersistence(store());
}

export function __resetClientStoreForTests(data: Partial<ClientStore> = {}): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistDirty = false;
  initGeneration++;
  memory = hydrateStore(data);
  adapter = null;
  initPromise = null;
  config = { kind: "indexeddb", encryptionEnabled: false };
  pendingDeletedDiscussionIds.clear();
  mergedBenchmarkRunIds.clear();
  corruptBenchmarkRunIds.clear();
  notifyReady();
}

export function __clearClientStoreForTests(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistDirty = false;
  initGeneration++;
  memory = null;
  adapter = null;
  initPromise = null;
  config = { kind: "indexeddb", encryptionEnabled: false };
  benchmarkRunBlobStorageForTests = null;
  pendingDeletedDiscussionIds.clear();
  mergedBenchmarkRunIds.clear();
  corruptBenchmarkRunIds.clear();
}

export async function __loadClientStoreFromAdapterForTests(
  next: StorageAdapter
): Promise<{ needsPassphrase: boolean }> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistDirty = false;
  initGeneration++;
  memory = null;
  adapter = next;
  initPromise = null;
  config = { kind: next.kind, encryptionEnabled: false };
  pendingDeletedDiscussionIds.clear();
  const raw = await next.load();
  const persisted = raw
    ? parseEnvelope(raw)
      ? JSON.parse(await unwrap(parseEnvelope(raw)!))
      : JSON.parse(raw)
    : {};
  memory = await loadDiscussionStoreFields(
    hydrateStore(stripBenchmarkStoreFields(persisted))
  );
  notifyReady();
  return { needsPassphrase: false };
}

export async function __setClientStorePassphraseForTests(
  passphrase: string
): Promise<string> {
  return setCryptoPassphrase(passphrase);
}

export async function __unlockClientStoreForTests(
  passphrase: string,
  saltB64: string
): Promise<void> {
  await unlockCrypto(passphrase, saltB64);
}

export function __lockClientStoreForTests(): void {
  lockCrypto();
}

/** Switch storage location / encryption and rewrite the current data there. */
export async function applyStorageConfig(next: StorageConfig): Promise<void> {
  config = next;
  await setStorageConfig(next);
  adapter = await createAdapter(next);
  await flush();
}
