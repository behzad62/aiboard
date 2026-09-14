import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentActor } from "./agent-contracts.js";
import type { ManagedProcessRecord, ManagedProcessSnapshot, ManagedProcessObservation } from "./managed-process-contracts.js";

export function readHistoricalManagedProcessObservations(
  stateDirectory: string,
  runId: string,
  maxPollBytes = 256 * 1024,
): ManagedProcessObservation[] {
  if (!Number.isSafeInteger(maxPollBytes) || maxPollBytes < 1) {
    throw new Error("Historical managed-process maxPollBytes must be positive.");
  }
  const directory = resolve(stateDirectory);
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const observations: ManagedProcessObservation[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
    const record = readHistoricalManagedProcessRecord(path);
    if (record.runId !== runId) continue;
    observations.push({
      ...historicalSnapshot(record, maxPollBytes),
      runId: record.runId,
      sessionId: record.sessionId,
      actor: { ...record.actor },
      command: record.command,
      args: [...record.args],
      cwd: record.cwd,
      environmentKeys: [...record.environmentKeys],
    });
  }
  return observations.sort(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) ||
      left.processId.localeCompare(right.processId),
  );
}

export function readHistoricalManagedProcessRecord(path: string): ManagedProcessRecord {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Historical managed-process record ${path} is invalid.`, { cause: error });
  }
  if (!isHistoricalManagedProcessRecord(value)) {
    throw new Error(`Historical managed-process record ${path} is malformed.`);
  }
  return value;
}

function isHistoricalManagedProcessRecord(value: unknown): value is ManagedProcessRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.processId === "string" &&
    typeof record.pid === "number" &&
    typeof record.runId === "string" &&
    typeof record.sessionId === "string" &&
    isAgentActor(record.actor) &&
    typeof record.command === "string" &&
    Array.isArray(record.args) && record.args.every((arg) => typeof arg === "string") &&
    typeof record.cwd === "string" &&
    Array.isArray(record.environmentKeys) &&
      record.environmentKeys.every((key) => typeof key === "string") &&
    typeof record.startedAt === "string" &&
    typeof record.updatedAt === "string" &&
    (record.status === "running" || record.status === "stopped" || record.status === "exited_unknown") &&
    (typeof record.exitCode === "number" || record.exitCode === null) &&
    (typeof record.signal === "string" || record.signal === null) &&
    typeof record.stdoutPath === "string" &&
    typeof record.stderrPath === "string" &&
    (record.backendOwnershipReleasedAt === undefined || typeof record.backendOwnershipReleasedAt === "string")
  );
}

function isAgentActor(value: unknown): value is AgentActor {
  return Boolean(
    value &&
      typeof value === "object" &&
      ((value as { role?: unknown }).role === "architect" ||
        (value as { role?: unknown }).role === "worker" ||
        (value as { role?: unknown }).role === "subagent" ||
        (value as { role?: unknown }).role === "verifier") &&
      typeof (value as { id?: unknown }).id === "string",
  );
}

export function historicalSnapshot(
  record: ManagedProcessRecord,
  maxPollBytes: number,
): ManagedProcessSnapshot {
  return {
    processId: record.processId,
    pid: record.pid,
    status: record.status,
    exitCode: record.exitCode,
    signal: record.signal,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    stdout: tail(record.stdoutPath, maxPollBytes),
    stderr: tail(record.stderrPath, maxPollBytes),
  };
}

function tail(path: string, maximum: number): string {
  try {
    const bytes = readFileSync(path);
    return bytes.subarray(Math.max(0, bytes.byteLength - maximum)).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
