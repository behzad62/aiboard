/**
 * Client-side store. Loads a single JSON blob once (async) from a StorageAdapter,
 * keeps it in memory for synchronous reads, and persists mutations async
 * (debounced). Mirrors the server `lib/db` API so call sites change minimally at
 * cutover. Browser-only.
 */

import type {
  CustomModel,
  Discussion,
  FinalResult,
  Message,
  ProviderKey,
  UserSettings,
} from "@/lib/db/schema";
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
  parseEnvelope,
  unwrap,
  wrap,
} from "./crypto-box";

export interface ClientStore {
  userSettings: UserSettings;
  providerKeys: ProviderKey[];
  customModels: CustomModel[];
  discussions: Discussion[];
  messages: Message[];
  finalResults: FinalResult[];
  attachments: AttachmentRecord[];
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
  },
  providerKeys: [],
  customModels: [],
  discussions: [],
  messages: [],
  finalResults: [],
  attachments: [],
};

let memory: ClientStore | null = null;
let adapter: StorageAdapter | null = null;
let config: StorageConfig = { kind: "indexeddb", encryptionEnabled: false };

export function isInitialized(): boolean {
  return memory !== null;
}

export function getConfig(): StorageConfig {
  return config;
}

/** Load config + adapter + store. Returns needsPassphrase=true if encrypted and locked. */
export async function initStore(): Promise<{ needsPassphrase: boolean }> {
  config = await getStorageConfig();
  adapter = await createAdapter(config);
  const raw = await adapter.load();

  if (raw === null) {
    memory = structuredClone(DEFAULT_STORE);
    return { needsPassphrase: false };
  }

  const env = parseEnvelope(raw);
  if (!env) {
    memory = { ...DEFAULT_STORE, ...(JSON.parse(raw) as Partial<ClientStore>) };
    return { needsPassphrase: false };
  }
  if (env.encrypted && !isUnlocked()) {
    return { needsPassphrase: true };
  }
  const json = await unwrap(env);
  memory = { ...DEFAULT_STORE, ...(JSON.parse(json) as Partial<ClientStore>) };
  return { needsPassphrase: false };
}

function store(): ClientStore {
  if (!memory) throw new Error("Client store not initialized");
  return memory;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => void flush(), 150);
}

export async function flush(): Promise<void> {
  if (!memory || !adapter) return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const env = await wrap(JSON.stringify(memory), config.encryptionEnabled);
  await adapter.save(JSON.stringify(env));
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
  schedulePersist();
}
/**
 * Wipe a discussion's run output (model messages + final result) for a
 * restart. User notes are kept — the next run still has to honor them.
 */
export function clearDiscussionRun(id: string): void {
  const s = store();
  s.messages = s.messages.filter(
    (m) => m.discussionId !== id || m.role === "user"
  );
  s.finalResults = s.finalResults.filter((r) => r.discussionId !== id);
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
  memory = { ...structuredClone(DEFAULT_STORE), ...data };
  schedulePersist();
}

export function exportStore(): ClientStore {
  return store();
}

/** Switch storage location / encryption and rewrite the current data there. */
export async function applyStorageConfig(next: StorageConfig): Promise<void> {
  config = next;
  await setStorageConfig(next);
  adapter = await createAdapter(next);
  await flush();
}
