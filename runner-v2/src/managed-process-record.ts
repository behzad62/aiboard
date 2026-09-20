import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ManagedProcessError, type ManagedProcessObservation, type ManagedProcessSnapshot } from "./managed-process-contracts.js";
import type { ManagedProcessIdentity } from "./managed-process-transport.js";

export const MAX_MANAGED_OUTPUT_BYTES = 256 * 1024;
export const MAX_MANAGED_RECORD_BYTES = 4 * 1024 * 1024;
export interface ManagedSessionRecord extends ManagedProcessObservation {
  readonly recordKind: "runner.managed-process";
  readonly schemaVersion: 2;
  readonly configurationDigest: string;
  readonly streamingSessionId: string;
  readonly launchId: string;
}
const fields = ["recordKind", "schemaVersion", "processId", "pid", "runId", "sessionId", "actor", "command", "args", "cwd", "environmentKeys", "startedAt", "updatedAt", "status", "exitCode", "signal", "stdout", "stderr", "configurationDigest", "streamingSessionId", "launchId"].sort();
const invalid = (detail: string): never => { throw new ManagedProcessError("process_record_invalid", `Managed process record ${detail}.`); };
export function managedProcessId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,96}$/.test(value) || value === "." || value === "..") return invalid("identity is invalid");
  return value;
}
function text(value: unknown, limit = 8192): value is string { return typeof value === "string" && value.length > 0 && !value.includes("\0") && Buffer.byteLength(value) <= limit; }
function date(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
export function parseManagedSessionRecord(value: unknown, expectedId?: string): Readonly<ManagedSessionRecord> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("is not an object");
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 2 || row.recordKind !== "runner.managed-process") throw new ManagedProcessError("process_active_schema_unsupported", "Managed process active schema is unsupported; exact legacy cleanup must be resolved before execution.");
  if (Object.keys(row).sort().join() !== fields.join()) return invalid("contains unknown or missing fields");
  const id = managedProcessId(row.processId);
  if (expectedId !== undefined && id !== expectedId) return invalid("identity does not match its owned entry");
  const actor = row.actor as Record<string, unknown> | undefined;
  if (!actor || Object.keys(actor).sort().join() !== "id,role" || !["architect", "worker", "subagent", "verifier"].includes(actor.role as string) || !text(actor.id, 256)) return invalid("actor is invalid");
  if (!text(row.runId, 256) || !text(row.sessionId, 256) || !text(row.command) || !text(row.cwd) || !isAbsolute(row.cwd)) return invalid("owner or command is invalid");
  if (!Array.isArray(row.args) || row.args.length > 1024 || row.args.some(arg => typeof arg !== "string" || arg.includes("\0")) || Buffer.byteLength(JSON.stringify(row.args)) > 128 * 1024) return invalid("arguments exceed their bound");
  if (!Array.isArray(row.environmentKeys) || row.environmentKeys.length > 256 || row.environmentKeys.some(key => typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) || new Set(row.environmentKeys).size !== row.environmentKeys.length) return invalid("environment key inventory is invalid");
  if (!Number.isSafeInteger(row.pid) || (row.pid as number) < 0 || !date(row.startedAt) || !date(row.updatedAt) || !["running", "stopped", "exited_unknown"].includes(row.status as string)) return invalid("observation is invalid");
  if (row.exitCode !== null && !Number.isSafeInteger(row.exitCode)) return invalid("exit code is invalid");
  if (row.signal !== null && (typeof row.signal !== "string" || !/^SIG[A-Z0-9]{1,16}$/.test(row.signal))) return invalid("signal is invalid");
  if ([row.stdout, row.stderr].some(value => typeof value !== "string" || Buffer.byteLength(value) > MAX_MANAGED_OUTPUT_BYTES)) return invalid("output exceeds its bound");
  if (typeof row.configurationDigest !== "string" || !/^[a-f0-9]{64}$/.test(row.configurationDigest) || row.streamingSessionId !== `managed-stream-${id}` || row.launchId !== `managed-launch-${id}`) return invalid("shared session identity is invalid");
  const copy = structuredClone(row) as unknown as ManagedSessionRecord;
  Object.freeze(copy.actor); Object.freeze(copy.args); Object.freeze(copy.environmentKeys);
  return Object.freeze(copy);
}

export function readManagedRecordValue(path: string): unknown {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > MAX_MANAGED_RECORD_BYTES) return invalid("entry is not a bounded private regular file");
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (cause) { throw new ManagedProcessError("process_record_invalid", `Managed process record cannot be parsed: ${cause instanceof Error ? cause.name : "unknown"}.`); }
}

export function persistManagedSessionRecord(directory: string, input: ManagedSessionRecord): Readonly<ManagedSessionRecord> {
  const record = parseManagedSessionRecord(input, input.processId);
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) return invalid("directory identity is invalid");
  const destination = join(directory, `${record.processId}.json`);
  try { const existing = lstatSync(destination); if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) return invalid("existing entry identity is invalid"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json) > MAX_MANAGED_RECORD_BYTES) return invalid("encoded bytes exceed their bound");
  const temporary = join(directory, `.${record.processId}-${randomUUID()}.pending`);
  writeFileSync(temporary, json, { flag: "wx", mode: 0o600 });
  const currentRoot = lstatSync(directory);
  if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || currentRoot.dev !== root.dev || currentRoot.ino !== root.ino) return invalid("directory changed before publication; exact temporary retained");
  renameSync(temporary, destination);
  return record;
}

export function managedIdentity(record: ManagedProcessIdentity): ManagedProcessIdentity {
  return Object.freeze({ processId: record.processId, runId: record.runId, sessionId: record.sessionId, actor: Object.freeze({ ...record.actor }) });
}
export function managedSnapshot(record: ManagedProcessSnapshot): ManagedProcessSnapshot {
  return Object.freeze({ processId: record.processId, pid: record.pid, status: record.status, exitCode: record.exitCode, signal: record.signal,
    startedAt: record.startedAt, updatedAt: record.updatedAt, stdout: record.stdout, stderr: record.stderr });
}
