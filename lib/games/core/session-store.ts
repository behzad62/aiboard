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

async function canUseStore(): Promise<boolean> {
  const { needsPassphrase } = await ensureReady();
  return !needsPassphrase;
}

async function ensureReady(): Promise<{ needsPassphrase: boolean }> {
  if (isInitialized()) return { needsPassphrase: false };
  return initStore();
}

export async function listGameSessions(): Promise<GameSessionRecord[]> {
  if (!(await canUseStore())) return [];
  return getGameSessions();
}

export async function saveGameSession(record: GameSessionRecord): Promise<void> {
  if (!(await canUseStore())) return;
  upsertGameSession(record);
}

export async function deleteGameSession(id: string): Promise<void> {
  if (!(await canUseStore())) return;
  deleteStoredGameSession(id);
}

export async function listGenericGameMatchRecords(): Promise<GenericGameMatchRecord[]> {
  if (!(await canUseStore())) return [];
  return getGenericGameMatchRecords();
}

export async function saveGenericGameMatchRecord(
  record: GenericGameMatchRecord
): Promise<void> {
  if (!(await canUseStore())) return;
  saveStoredGenericGameMatchRecord(record);
}

export function __resetGameSessionStoreForTests(): void {
  __resetClientStoreForTests();
}
