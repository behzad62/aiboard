import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import type { AgentActor, ToolExecutionContext } from "./agent-contracts.js";

export type ManagedProcessStatus = "running" | "stopped" | "exited_unknown";

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

export interface ManagedProcessServiceOptions {
  stateDirectory: string;
  idFactory?: () => string;
  clock?: () => string;
  maxPollBytes?: number;
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
  private readonly records = new Map<string, ManagedProcessRecord>();
  private readonly children = new Map<string, ChildProcess>();

  constructor(options: ManagedProcessServiceOptions) {
    this.stateDirectory = resolve(options.stateDirectory);
    this.idFactory = options.idFactory ?? (() => `process_${randomUUID()}`);
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.maxPollBytes = options.maxPollBytes ?? 256 * 1024;
    mkdirSync(this.stateDirectory, { recursive: true });
    for (const name of readdirSync(this.stateDirectory)) {
      if (!name.endsWith(".json")) continue;
      const record = JSON.parse(
        readFileSync(join(this.stateDirectory, name), "utf8")
      ) as ManagedProcessRecord;
      this.records.set(record.processId, record);
    }
  }

  start(
    input: StartManagedProcessInput,
    context: ToolExecutionContext,
    workspacePath: string
  ): ManagedProcessSnapshot {
    const processId = this.idFactory();
    if (this.records.has(processId)) {
      throw new ManagedProcessError("process_id_conflict", `Process ${processId} already exists.`);
    }
    const processDirectory = join(this.stateDirectory, processId);
    mkdirSync(processDirectory, { recursive: true });
    const stdoutPath = join(processDirectory, "stdout.log");
    const stderrPath = join(processDirectory, "stderr.log");
    const stdout = openSync(stdoutPath, "a");
    const stderr = openSync(stderrPath, "a");
    let child: ChildProcess;
    try {
      child = spawn(input.command, input.args ?? [], {
        cwd: resolve(workspacePath, input.cwd ?? "."),
        env: { ...process.env, ...(input.env ?? {}) },
        detached: true,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", stdout, stderr],
      });
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    if (!child.pid) {
      child.once("error", () => undefined);
      throw new ManagedProcessError("process_start_failed", "Background process has no PID.");
    }
    child.unref();
    const now = this.clock();
    const record: ManagedProcessRecord = {
      processId,
      pid: child.pid,
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
    };
    this.records.set(processId, record);
    this.children.set(processId, child);
    this.persist(record);
    child.once("exit", (exitCode, signal) => {
      const current = this.records.get(processId);
      if (!current) return;
      current.status = "stopped";
      current.exitCode = exitCode;
      current.signal = signal;
      current.updatedAt = this.clock();
      this.persist(current);
      this.children.delete(processId);
    });
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

  async signal(
    processId: string,
    signal: "SIGTERM" | "SIGINT" | "SIGKILL",
    context: ToolExecutionContext
  ): Promise<ManagedProcessSnapshot> {
    const record = this.ownedRecord(processId, context);
    this.reconcile(record);
    if (record.status !== "running") return this.snapshot(record);
    try {
      await terminateProcessTree(record.pid, signal);
      record.status = "exited_unknown";
      record.signal = signal;
      record.updatedAt = this.clock();
      this.persist(record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      record.status = "exited_unknown";
      record.updatedAt = this.clock();
      this.persist(record);
    }
    return this.snapshot(record);
  }

  close(): void {
    for (const child of this.children.values()) child.removeAllListeners();
    this.children.clear();
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

  private reconcile(record: ManagedProcessRecord): void {
    if (record.status !== "running") return;
    try {
      process.kill(record.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      record.status = "exited_unknown";
      record.updatedAt = this.clock();
      this.persist(record);
    }
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
    writeFileSync(temporary, JSON.stringify(record, null, 2));
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

async function terminateProcessTree(
  pid: number,
  signal: "SIGTERM" | "SIGINT" | "SIGKILL"
): Promise<void> {
  if (process.platform !== "win32") {
    process.kill(-pid, signal);
    return;
  }
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0 || exitCode === 128) resolvePromise();
      else reject(new Error(`taskkill exited with code ${String(exitCode)}.`));
    });
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
