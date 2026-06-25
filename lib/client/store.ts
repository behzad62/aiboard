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
  BenchmarkCase,
  BenchmarkFailure,
  BenchmarkMetricValue,
  BenchmarkModelCallTrace,
  BenchmarkRun,
  BenchmarkSuite,
} from "@/lib/benchmark/types";
import type { AttachmentRecord } from "@/lib/attachments/types";
import {
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
} from "@/lib/build-context/memory-store";

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
  benchmarkAttempts: BenchmarkAttempt[];
  benchmarkMetricValues: BenchmarkMetricValue[];
  benchmarkArtifacts: BenchmarkArtifact[];
  benchmarkFailures: BenchmarkFailure[];
  benchmarkTraces: BenchmarkModelCallTrace[];
  /** Global per-model Build performance, accumulated across all builds. */
  modelStats: ModelBuildStat[];
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
  benchmarkAttempts: [],
  benchmarkMetricValues: [],
  benchmarkArtifacts: [],
  benchmarkFailures: [],
  benchmarkTraces: [],
  modelStats: [],
};

function hydrateStore(data: Partial<ClientStore> = {}): ClientStore {
  return { ...structuredClone(DEFAULT_STORE), ...data };
}

let memory: ClientStore | null = null;
let adapter: StorageAdapter | null = null;
let config: StorageConfig = { kind: "indexeddb", encryptionEnabled: false };
let initPromise: Promise<{ needsPassphrase: boolean }> | null = null;
let initGeneration = 0;
const readyListeners = new Set<() => void>();

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
    commitLoadedStore(generation, hydrateStore());
    return { needsPassphrase: false };
  }

  const env = parseEnvelope(raw);
  if (!env) {
    commitLoadedStore(generation, hydrateStore(JSON.parse(raw) as Partial<ClientStore>));
    return { needsPassphrase: false };
  }
  if (env.encrypted && !isUnlocked()) {
    return { needsPassphrase: true };
  }
  const json = await unwrap(env);
  commitLoadedStore(generation, hydrateStore(JSON.parse(json) as Partial<ClientStore>));
  return { needsPassphrase: false };
}

function commitLoadedStore(generation: number, loaded: ClientStore): void {
  if (generation !== initGeneration || memory) return;
  memory = loaded;
  notifyReady();
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
  if (config.encryptionEnabled && !isUnlocked()) {
    persistDirty = true;
    return;
  }
  const env = await wrap(JSON.stringify(memory), config.encryptionEnabled);
  await adapter.save(JSON.stringify(env));
  persistDirty = false;
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
export function getBenchmarkAttempts(): BenchmarkAttempt[] {
  const s = store();
  s.benchmarkAttempts ??= [];
  return s.benchmarkAttempts;
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
export function hasAttemptedGameStatsLegacyImport(): boolean {
  return store().gameStatsLegacyImportAttempted ?? false;
}
export function getModelStats(): ModelBuildStat[] {
  return (store().modelStats ?? []).map(normalizeStat);
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
  schedulePersist();
}
/** One build's per-worker contribution to a model's global stats. */
export type ModelStatDelta = Omit<
  ModelBuildStat,
  "builds" | "judges" | "independentVerdicts" | "updatedAt"
>;

/** Fill any fields absent from a record persisted before they existed. */
function normalizeStat(m: Partial<ModelBuildStat> & { modelId: string }): ModelBuildStat {
  return {
    modelId: m.modelId,
    displayName: m.displayName ?? m.modelId,
    builds: m.builds ?? 0,
    attempts: m.attempts ?? 0,
    approvals: m.approvals ?? 0,
    fixes: m.fixes ?? 0,
    badOutput: m.badOutput ?? 0,
    unavailable: m.unavailable ?? 0,
    wApprovals: m.wApprovals ?? 0,
    wFixes: m.wFixes ?? 0,
    wBadOutput: m.wBadOutput ?? 0,
    responseMs: m.responseMs ?? 0,
    responseChars: m.responseChars ?? 0,
    judges: { ...(m.judges ?? {}) },
    independentVerdicts: m.independentVerdicts ?? 0,
    updatedAt: m.updatedAt ?? new Date(0).toISOString(),
  };
}

/** Fold one build's per-worker results into the global per-model stats. */
export function accumulateModelStats(input: {
  judgeModelId: string;
  workers: ModelStatDelta[];
}): void {
  const s = store();
  if (!s.modelStats) s.modelStats = []; // stores persisted before this field existed
  const now = new Date().toISOString();
  for (const d of input.workers) {
    if (d.attempts <= 0) continue;
    // Only Architect approve/fix verdicts count as judge verdicts; engine-
    // detected bad output and provider denials were never graded by anyone.
    const verdicts = d.approvals + d.fixes;
    const independent = input.judgeModelId !== d.modelId ? verdicts : 0;
    const prev = s.modelStats.find((m) => m.modelId === d.modelId);
    if (prev) {
      // Coalesce against records persisted before these fields existed.
      const existing = normalizeStat(prev);
      existing.displayName = d.displayName;
      existing.builds += 1;
      existing.attempts += d.attempts;
      existing.approvals += d.approvals;
      existing.fixes += d.fixes;
      existing.badOutput += d.badOutput;
      existing.unavailable += d.unavailable;
      existing.wApprovals += d.wApprovals;
      existing.wFixes += d.wFixes;
      existing.wBadOutput += d.wBadOutput;
      existing.responseMs += d.responseMs;
      existing.responseChars += d.responseChars;
      // Don't list a judge that contributed no verdicts (e.g. all attempts
      // were provider denials) — it never actually graded this model.
      if (verdicts > 0) {
        existing.judges[input.judgeModelId] =
          (existing.judges[input.judgeModelId] ?? 0) + verdicts;
      }
      existing.independentVerdicts += independent;
      existing.updatedAt = now;
      s.modelStats[s.modelStats.indexOf(prev)] = existing;
    } else {
      s.modelStats.push({
        ...d,
        builds: 1,
        judges: verdicts > 0 ? { [input.judgeModelId]: verdicts } : {},
        independentVerdicts: independent,
        updatedAt: now,
      });
    }
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
  if (s.buildMemories.length > 500) {
    s.buildMemories = s.buildMemories
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .slice(0, 500);
  }
  schedulePersist();
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
export function upsertBenchmarkAttempt(record: BenchmarkAttempt): void {
  upsertById(getBenchmarkAttempts(), record);
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
