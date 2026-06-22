import {
  deleteGameSession as deleteStoredGameSession,
  getGameSessions,
  getGenericGameMatchRecords,
  __resetClientStoreForTests,
  initStore,
  isInitialized,
  saveGenericGameMatchRecord as saveStoredGenericGameMatchRecord,
  upsertGameSession,
} from "../../client/store";
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
