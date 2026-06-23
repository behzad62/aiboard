import {
  __clearClientStoreForTests,
  __lockClientStoreForTests,
  __setClientStorePassphraseForTests,
  __unlockClientStoreForTests,
  deleteGameSession as deleteStoredGameSession,
  exportStore,
  flush,
  getGameSessions,
  getGenericGameMatchRecords,
  __resetClientStoreForTests,
  initStore,
  isInitialized,
  replaceStore,
  saveGenericGameMatchRecord as saveStoredGenericGameMatchRecord,
  upsertGameSession,
} from "../../client/store";
import type { ClientStore } from "../../client/store";
import type {
  GameSessionRecord,
  GenericGameMatchRecord,
} from "./types";

let readinessOverrideForTests: { needsPassphrase: boolean } | null = null;

async function canUseStore(): Promise<boolean> {
  const { needsPassphrase } = await ensureReady();
  return !needsPassphrase;
}

async function requireWritableStore(): Promise<void> {
  const { needsPassphrase } = await ensureReady();
  if (needsPassphrase) {
    throw new Error("Unlock storage before modifying game data.");
  }
}

async function ensureReady(): Promise<{ needsPassphrase: boolean }> {
  if (readinessOverrideForTests) return readinessOverrideForTests;
  if (isInitialized()) return { needsPassphrase: false };
  return initStore();
}

export async function listGameSessions(): Promise<GameSessionRecord[]> {
  if (!(await canUseStore())) return [];
  return [...getGameSessions()];
}

export async function saveGameSession(record: GameSessionRecord): Promise<void> {
  await requireWritableStore();
  upsertGameSession(record);
}

export async function deleteGameSession(id: string): Promise<void> {
  await requireWritableStore();
  deleteStoredGameSession(id);
}

export async function listGenericGameMatchRecords(): Promise<GenericGameMatchRecord[]> {
  if (!(await canUseStore())) return [];
  return [...getGenericGameMatchRecords()];
}

export async function saveGenericGameMatchRecord(
  record: GenericGameMatchRecord
): Promise<void> {
  await requireWritableStore();
  saveStoredGenericGameMatchRecord(record);
}

export function __resetGameSessionStoreForTests(options?: {
  needsPassphrase?: boolean;
}): void {
  readinessOverrideForTests =
    options?.needsPassphrase === undefined
      ? null
      : { needsPassphrase: options.needsPassphrase };
  __resetClientStoreForTests();
}

export function __clearGameSessionStoreForTests(): void {
  readinessOverrideForTests = null;
  __clearClientStoreForTests();
}

export async function __initGameSessionStoreForTests(): Promise<{
  needsPassphrase: boolean;
}> {
  return initStore();
}

export async function __flushGameSessionStoreForTests(): Promise<void> {
  await flush();
}

export function __exportGameSessionStoreForTests(): ClientStore {
  return exportStore();
}

export function __replaceGameSessionStoreForTests(data: Partial<ClientStore>): void {
  replaceStore(data);
}

export async function __setGameSessionStorePassphraseForTests(
  passphrase: string
): Promise<string> {
  return __setClientStorePassphraseForTests(passphrase);
}

export async function __unlockGameSessionStoreForTests(
  passphrase: string,
  saltB64: string
): Promise<void> {
  await __unlockClientStoreForTests(passphrase, saltB64);
}

export function __lockGameSessionStoreForTests(): void {
  __lockClientStoreForTests();
}
