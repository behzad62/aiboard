import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentActor, ToolExecutionContext } from "./agent-contracts.js";

const SUPERVISOR_PROTOCOL = "aiboard-managed-process/v1";
const DEFAULT_START_DEADLINE_MS = 5_000;
const DEFAULT_STOP_DEADLINE_MS = 5_000;

export type ManagedProcessStatus = "running" | "stopped" | "exited_unknown";

export interface ManagedProcessSupervisorRecord {
  protocol: typeof SUPERVISOR_PROTOCOL;
  token: string;
  statusPath: string;
  supervisorPid: number;
  port: number;
}

export interface ManagedProcessRecord {
  processId: string;
  pid: number;
  runId: string;
  sessionId: string;
  actor: AgentActor;
  command: string;
  args: string[];
  cwd: string;
  environmentKeys: string[];
  startedAt: string;
  updatedAt: string;
  status: ManagedProcessStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutPath: string;
  stderrPath: string;
  supervisor?: ManagedProcessSupervisorRecord;
}

interface SupervisorStatus {
  protocol: typeof SUPERVISOR_PROTOCOL;
  processId: string;
  supervisorPid: number;
  childPid: number;
  port: number;
  status: "starting" | "running" | "stopped" | "exited_unknown";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
  ownershipReleased: boolean;
  updatedAt: string;
}

export interface StartManagedProcessInput {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ManagedProcessSnapshot {
  processId: string;
  pid: number;
  status: ManagedProcessStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  updatedAt: string;
  stdout: string;
  stderr: string;
}

export interface ManagedProcessObservation extends ManagedProcessSnapshot {
  runId: string;
  sessionId: string;
  actor: AgentActor;
  command: string;
  args: string[];
  cwd: string;
  environmentKeys: string[];
}

export interface ManagedProcessServiceOptions {
  stateDirectory: string;
  platform?: NodeJS.Platform;
  idFactory?: () => string;
  clock?: () => string;
  maxPollBytes?: number;
  startDeadlineMs?: number;
  stopDeadlineMs?: number;
  supervisorScriptPath?: string;
}

export class ManagedProcessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ManagedProcessError";
  }
}

export class ManagedProcessService {
  private readonly stateDirectory: string;
  private readonly idFactory: () => string;
  private readonly clock: () => string;
  private readonly maxPollBytes: number;
  private readonly startDeadlineMs: number;
  private readonly stopDeadlineMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly supervisorScriptPath: string;
  private readonly records = new Map<string, ManagedProcessRecord>();
  private readonly launchers = new Set<ChildProcess>();

  constructor(options: ManagedProcessServiceOptions) {
    this.stateDirectory = resolve(options.stateDirectory);
    this.idFactory = options.idFactory ?? (() => `process_${randomUUID()}`);
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.maxPollBytes = options.maxPollBytes ?? 256 * 1024;
    this.startDeadlineMs = options.startDeadlineMs ?? DEFAULT_START_DEADLINE_MS;
    this.stopDeadlineMs = options.stopDeadlineMs ?? DEFAULT_STOP_DEADLINE_MS;
    this.platform = options.platform ?? process.platform;
    this.supervisorScriptPath = options.supervisorScriptPath ?? join(
      dirname(fileURLToPath(import.meta.url)),
      "managed-process-supervisor.mjs"
    );
    mkdirSync(this.stateDirectory, { recursive: true });
    for (const name of readdirSync(this.stateDirectory)) {
      if (!name.endsWith(".json")) continue;
      const record = JSON.parse(
        readFileSync(join(this.stateDirectory, name), "utf8")
      ) as ManagedProcessRecord;
      this.records.set(record.processId, record);
    }
  }

  async start(
    input: StartManagedProcessInput,
    context: ToolExecutionContext,
    workspacePath: string
  ): Promise<ManagedProcessSnapshot> {
    if (this.platform !== "win32") {
      throw new ManagedProcessError(
        "process_containment_unavailable",
        "Background process containment is unavailable on this platform. " +
          "This Runner release requires Windows Job Objects and refused to launch anything."
      );
    }
    const processId = this.idFactory();
    if (this.records.has(processId)) {
      throw new ManagedProcessError("process_id_conflict", `Process ${processId} already exists.`);
    }
    const processDirectory = join(this.stateDirectory, processId);
    mkdirSync(processDirectory, { recursive: true });
    const stdoutPath = join(processDirectory, "stdout.log");
    const stderrPath = join(processDirectory, "stderr.log");
    const statusPath = join(processDirectory, "supervisor.jsonl");
    const token = randomBytes(32).toString("hex");
    const now = this.clock();
    const record: ManagedProcessRecord = {
      processId,
      pid: 0,
      runId: context.runId,
      sessionId: context.sessionId,
      actor: { ...context.actor },
      command: input.command,
      args: [...(input.args ?? [])],
      cwd: resolve(workspacePath, input.cwd ?? "."),
      environmentKeys: Object.keys(input.env ?? {}).sort(),
      startedAt: now,
      updatedAt: now,
      status: "running",
      exitCode: null,
      signal: null,
      stdoutPath,
      stderrPath,
      supervisor: {
        protocol: SUPERVISOR_PROTOCOL,
        token,
        statusPath,
        supervisorPid: 0,
        port: 0,
      },
    };
    const launcher = spawn(process.execPath, [
      this.supervisorScriptPath,
      processId,
      statusPath,
    ], {
      detached: true,
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore", "ipc"],
    });
    this.launchers.add(launcher);
    launcher.once("exit", () => this.launchers.delete(launcher));
    launcher.once("error", () => this.launchers.delete(launcher));
    if (!launcher.pid) {
      throw new ManagedProcessError("process_start_failed", "Supervisor process has no PID.");
    }
    record.supervisor!.supervisorPid = launcher.pid;
    record.updatedAt = this.clock();
    this.records.set(processId, record);
    this.persist(record);

    const config = JSON.stringify({
      processId,
      token,
      statusPath,
      stdoutPath,
      stderrPath,
      command: input.command,
      args: [...(input.args ?? [])],
      cwd: record.cwd,
      env: mergeManagedEnvironment(process.env, input.env ?? {}),
      stopDeadlineMs: this.stopDeadlineMs,
    });
    let supervisorStatus: SupervisorStatus;
    try {
      await writeSupervisorConfig(launcher, config);
      supervisorStatus = await waitForSupervisor(
        statusPath,
        processId,
        launcher.pid,
        token,
        this.startDeadlineMs
      );
    } catch (error) {
      try {
        await abortStartingSupervisor(launcher, token, this.stopDeadlineMs);
      } catch (abortError) {
        throw new ManagedProcessError(
          "process_start_failed",
          `${error instanceof Error ? error.message : String(error)} ` +
            `Supervisor abort failed: ${abortError instanceof Error ? abortError.message : String(abortError)}`
        );
      }
      throw error;
    }
    this.applySupervisorStatus(record, supervisorStatus);
    if (supervisorStatus.status === "stopped" && supervisorStatus.error) {
      throw new ManagedProcessError("process_start_failed", supervisorStatus.error);
    }
    if (supervisorStatus.status === "starting") {
      throw new ManagedProcessError(
        "process_start_failed",
        "Managed process supervisor did not confirm child startup."
      );
    }
    if (launcher.connected) launcher.disconnect();
    launcher.unref();
    this.launchers.delete(launcher);
    return this.snapshot(record);
  }

  poll(processId: string, context: ToolExecutionContext): ManagedProcessSnapshot {
    const record = this.ownedRecord(processId, context);
    this.reconcile(record);
    return this.snapshot(record);
  }

  list(context: ToolExecutionContext): ManagedProcessSnapshot[] {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.runId === context.runId && record.sessionId === context.sessionId
      )
      .map((record) => {
        this.reconcile(record);
        return this.snapshot(record);
      });
  }

  listRun(runId: string): ManagedProcessObservation[] {
    return [...this.records.values()]
      .filter((record) => record.runId === runId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map((record) => {
        this.reconcile(record);
        return {
          ...this.snapshot(record),
          runId: record.runId,
          sessionId: record.sessionId,
          actor: { ...record.actor },
          command: record.command,
          args: [...record.args],
          cwd: record.cwd,
          environmentKeys: [...record.environmentKeys],
        };
      });
  }

  async signal(
    processId: string,
    signal: "SIGTERM" | "SIGINT" | "SIGKILL",
    context: ToolExecutionContext
  ): Promise<ManagedProcessSnapshot> {
    const record = this.ownedRecord(processId, context);
    await this.signalRecord(record, signal);
    return this.snapshot(record);
  }

  async stopRun(runId: string): Promise<void> {
    const records = [...this.records.values()].filter((record) => record.runId === runId);
    const failures: unknown[] = [];
    for (const record of records) {
      this.reconcile(record);
      if (record.status === "stopped") continue;
      try {
        await this.signalRecord(record, "SIGTERM");
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Could not stop all managed processes for settled Build ${runId}.`
      );
    }
  }

  close(): void {
    for (const launcher of this.launchers) launcher.removeAllListeners();
    this.launchers.clear();
  }

  private ownedRecord(
    processId: string,
    context: ToolExecutionContext
  ): ManagedProcessRecord {
    const disk = this.readRecord(processId);
    if (disk) this.records.set(processId, disk);
    const record = this.records.get(processId);
    if (!record) {
      throw new ManagedProcessError("process_not_found", `Process ${processId} was not found.`);
    }
    if (record.runId !== context.runId || record.sessionId !== context.sessionId) {
      throw new ManagedProcessError(
        "process_not_owned",
        `Process ${processId} belongs to another agent session.`
      );
    }
    return record;
  }

  private async signalRecord(
    record: ManagedProcessRecord,
    signal: "SIGTERM" | "SIGINT" | "SIGKILL"
  ): Promise<void> {
    if (!validSupervisorIdentity(record.supervisor)) {
      throw new ManagedProcessError(
        "process_control_unavailable",
        `Process ${record.processId} predates authenticated supervision and cannot be signalled safely.`
      );
    }
    this.reconcile(record);
    if (record.status === "stopped") return;
    if (!validSupervisorEndpoint(record.supervisor)) {
      throw new ManagedProcessError(
        "process_control_unavailable",
        `Authenticated supervisor endpoint for ${record.processId} is not recoverable.`
      );
    }
    let confirmedStatus: SupervisorStatus;
    try {
      confirmedStatus = await supervisorRequest(
        record.supervisor,
        "/signal",
        "POST",
        {
          signal,
          deadlineMs: this.stopDeadlineMs,
        },
        this.stopDeadlineMs + 250
      );
      this.applySupervisorStatus(record, confirmedStatus);
    } catch (error) {
      throw new ManagedProcessError(
        "process_control_unavailable",
        `Authenticated supervisor for ${record.processId} could not confirm termination: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    if (confirmedStatus.status !== "stopped") {
      throw new ManagedProcessError(
        "process_stop_timeout",
        `Managed process ${record.processId} did not stop before the deadline.`
      );
    }
  }

  private reconcile(record: ManagedProcessRecord): void {
    if (record.status === "stopped") return;
    if (!validSupervisorIdentity(record.supervisor)) {
      record.status = "exited_unknown";
      record.updatedAt = this.clock();
      this.persist(record);
      return;
    }
    const status = readSupervisorStatus(record.supervisor.statusPath);
    if (!status || !matchesSupervisor(record, status)) {
      record.status = "exited_unknown";
      record.updatedAt = this.clock();
      this.persist(record);
      return;
    }
    this.applySupervisorStatus(record, status);
  }

  private applySupervisorStatus(
    record: ManagedProcessRecord,
    status: SupervisorStatus
  ): void {
    if (!record.supervisor || !matchesSupervisor(record, status)) {
      throw new ManagedProcessError(
        "process_control_unavailable",
        `Supervisor identity mismatch for ${record.processId}.`
      );
    }
    record.pid = status.childPid;
    record.supervisor.port = status.port;
    record.status = status.status === "stopped"
      ? "stopped"
      : status.status === "exited_unknown"
        ? "exited_unknown"
        : "running";
    record.exitCode = status.exitCode;
    record.signal = status.signal;
    record.updatedAt = status.updatedAt;
    this.persist(record);
  }

  private snapshot(record: ManagedProcessRecord): ManagedProcessSnapshot {
    return {
      processId: record.processId,
      pid: record.pid,
      status: record.status,
      exitCode: record.exitCode,
      signal: record.signal,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      stdout: tail(record.stdoutPath, this.maxPollBytes),
      stderr: tail(record.stderrPath, this.maxPollBytes),
    };
  }

  private persist(record: ManagedProcessRecord): void {
    const destination = join(this.stateDirectory, `${record.processId}.json`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
    renameSync(temporary, destination);
  }

  private readRecord(processId: string): ManagedProcessRecord | null {
    try {
      return JSON.parse(
        readFileSync(join(this.stateDirectory, `${processId}.json`), "utf8")
      ) as ManagedProcessRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

function mergeManagedEnvironment(
  inherited: NodeJS.ProcessEnv,
  overrides: Record<string, string>
): Record<string, string> {
  if (process.platform !== "win32") {
    return Object.fromEntries([
      ...Object.entries(inherited).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      ),
      ...Object.entries(overrides),
    ]);
  }
  const values = new Map<string, { key: string; value: string }>();
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) values.set(key.toLowerCase(), { key, value });
  }
  for (const [key, value] of Object.entries(overrides)) {
    values.set(key.toLowerCase(), { key, value });
  }
  return Object.fromEntries([...values.values()].map(({ key, value }) => [key, value]));
}

function validSupervisorIdentity(
  supervisor: ManagedProcessSupervisorRecord | undefined
): supervisor is ManagedProcessSupervisorRecord {
  return Boolean(
    supervisor &&
      supervisor.protocol === SUPERVISOR_PROTOCOL &&
      typeof supervisor.token === "string" &&
      supervisor.token.length >= 32 &&
      typeof supervisor.statusPath === "string" &&
      supervisor.statusPath.length > 0 &&
      Number.isInteger(supervisor.supervisorPid) &&
      supervisor.supervisorPid > 0 &&
      Number.isInteger(supervisor.port) &&
      supervisor.port >= 0 &&
      supervisor.port <= 65_535
  );
}

function validSupervisorEndpoint(
  supervisor: ManagedProcessSupervisorRecord | undefined
): supervisor is ManagedProcessSupervisorRecord {
  return validSupervisorIdentity(supervisor) && supervisor.port > 0;
}

function readSupervisorStatus(path: string): SupervisorStatus | null {
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      try {
        return JSON.parse(line) as SupervisorStatus;
      } catch {
        // A crash can leave only the final appended line incomplete. Earlier
        // immutable records remain valid recovery checkpoints.
      }
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function matchesSupervisor(record: ManagedProcessRecord, status: SupervisorStatus): boolean {
  return Boolean(
    record.supervisor &&
      status.protocol === SUPERVISOR_PROTOCOL &&
      status.processId === record.processId &&
      status.supervisorPid === record.supervisor.supervisorPid &&
      (record.supervisor.port === 0 || status.port === record.supervisor.port)
  );
}

async function waitForSupervisor(
  statusPath: string,
  processId: string,
  supervisorPid: number,
  token: string,
  deadlineMs: number
): Promise<SupervisorStatus> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const status = readSupervisorStatus(statusPath);
    if (
      status &&
      status.protocol === SUPERVISOR_PROTOCOL &&
      status.processId === processId &&
      status.supervisorPid === supervisorPid &&
      status.port > 0
    ) {
      if (status.status === "stopped" || status.status === "exited_unknown") return status;
      if (status.status === "running") {
        const authenticated = await supervisorRequest(
          {
            protocol: SUPERVISOR_PROTOCOL,
            token,
            statusPath,
            supervisorPid,
            port: status.port,
          },
          "/status",
          "GET",
          undefined,
          Math.max(250, deadline - Date.now())
        );
        if (
          authenticated.processId === processId &&
          authenticated.supervisorPid === supervisorPid
        ) return authenticated;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new ManagedProcessError(
    "process_start_failed",
    "Managed process supervisor did not become ready before the deadline."
  );
}

async function supervisorRequest(
  supervisor: ManagedProcessSupervisorRecord,
  path: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
  timeoutMs = DEFAULT_STOP_DEADLINE_MS + 250
): Promise<SupervisorStatus> {
  const payload = body ? Buffer.from(JSON.stringify(body)) : undefined;
  return await new Promise<SupervisorStatus>((resolvePromise, reject) => {
    const call = request(
      {
        hostname: "127.0.0.1",
        port: supervisor.port,
        path,
        method,
        headers: {
          authorization: `Bearer ${supervisor.token}`,
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": String(payload.byteLength),
              }
            : {}),
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode !== 200) {
            reject(new Error(`Supervisor returned HTTP ${String(response.statusCode)}: ${text}`));
            return;
          }
          try {
            resolvePromise(JSON.parse(text) as SupervisorStatus);
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    call.once("timeout", () => call.destroy(new Error("Supervisor request timed out.")));
    call.once("error", reject);
    if (payload) call.write(payload);
    call.end();
  });
}

async function writeSupervisorConfig(
  launcher: ChildProcess,
  serialized: string
): Promise<void> {
  if (!launcher.stdin) throw new Error("Supervisor configuration pipe is unavailable.");
  await new Promise<void>((resolvePromise, reject) => {
    launcher.stdin!.end(serialized, (error?: Error | null) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}

async function abortStartingSupervisor(
  launcher: ChildProcess,
  token: string,
  deadlineMs: number
): Promise<void> {
  if (launcher.exitCode !== null || launcher.signalCode !== null) return;
  const acknowledged = await new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      launcher.off("message", onMessage);
      launcher.off("exit", onExit);
      resolvePromise(value);
    };
    const onMessage = (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        (message as { type?: unknown }).type === "abort_ack" &&
        (message as { token?: unknown }).token === token
      ) finish(true);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(250, deadlineMs));
    launcher.on("message", onMessage);
    launcher.once("exit", onExit);
    if (!launcher.connected) {
      finish(false);
      return;
    }
    launcher.send({ type: "abort", token }, (error) => {
      if (error) finish(false);
    });
  });
  if (!acknowledged && launcher.exitCode === null && launcher.signalCode === null) {
    launcher.kill("SIGKILL");
  }
  await waitForChildExit(launcher, Math.max(250, deadlineMs));
  if (launcher.exitCode === null && launcher.signalCode === null) {
    throw new Error("Supervisor did not acknowledge abort or exit before the deadline.");
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    const onExit = () => {
      clearTimeout(timer);
      resolvePromise();
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolvePromise();
    }, timeoutMs);
    child.once("exit", onExit);
  });
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
