import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { runGit, type GitCommandOptions } from "./git-command.js";
import type { GitRunner } from "./git-repository.js";
import type { VerificationWorkspaceManager } from "./verification-workspace.js";

const MAX_ITEMS = 200;
const MAX_TEXT_BYTES = 32 * 1024;

export interface FinalVerificationDiagnosticsInput {
  generationId: string;
  taskId: string;
  targetRevision: string;
  checks: readonly unknown[];
  evidenceReferences: readonly string[];
  logs?: readonly string[];
}

export interface FinalVerificationDiagnosticsWriter {
  persist(input: FinalVerificationDiagnosticsInput): Promise<string>;
}

export class FinalVerificationDiagnosticsArchive implements FinalVerificationDiagnosticsWriter {
  private readonly stateDirectory: string;
  private readonly execute: GitRunner;
  constructor(private readonly options: {
    stateDirectory: string;
    runId: string;
    workspaceManager: VerificationWorkspaceManager;
    execute?: GitRunner;
  }) {
    this.stateDirectory = resolve(options.stateDirectory);
    this.execute = options.execute ?? runGit;
  }

  async persist(input: FinalVerificationDiagnosticsInput): Promise<string> {
    assertIdentity(input.generationId, "generationId");
    assertIdentity(input.taskId, "taskId");
    const workspace = await this.options.workspaceManager.inspectOwned();
    if (workspace.runId !== this.options.runId || workspace.targetRevision !== input.targetRevision) {
      throw new Error("Verification diagnostics identity does not match the owned workspace.");
    }
    const status = (await this.git(workspace.path, [
      "status", "--porcelain=v1", "-z", "--untracked-files=all",
    ])).stdout;
    const changedPaths = parseStatusPaths(status).slice(0, MAX_ITEMS);
    const directory = join(
      this.stateDirectory,
      "builds",
      safeSegment(this.options.runId),
      "audit",
      "final-verification-diagnostics",
    );
    const destination = join(directory, `${safeSegment(input.generationId)}.json`);
    const record = {
      version: 1,
      kind: "final-verification-diagnostics",
      runId: this.options.runId,
      generationId: input.generationId,
      taskId: input.taskId,
      targetRevision: input.targetRevision,
      workspaceId: workspace.workspaceId,
      changedPaths,
      checks: boundJson(input.checks),
      evidenceReferences: input.evidenceReferences.slice(0, MAX_ITEMS).map(redactAndBound),
      logs: (input.logs ?? []).slice(0, MAX_ITEMS).map(redactAndBound),
    };
    await mkdir(directory, { recursive: true });
    try {
      const existing = await readFile(destination, "utf8");
      if (existing === `${JSON.stringify(record, null, 2)}\n`) return destination;
      throw new Error("Final verification diagnostics archive conflicts with existing durable evidence.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    try { await rename(temporary, destination); }
    finally { await rm(temporary, { force: true }).catch(() => undefined); }
    return destination;
  }

  private async git(cwd: string, args: readonly string[]) {
    const options: GitCommandOptions = { cwd, args };
    return await this.execute(options);
  }
}

export class OwnedFinalVerificationCleanup {
  private completed = false;
  constructor(private readonly options: {
    runId: string;
    stopRun(runId: string): Promise<void>;
    closeBrowserRun(runId: string): Promise<void>;
    workspaceManager: VerificationWorkspaceManager;
    diagnostics?: FinalVerificationDiagnosticsWriter;
  }) {}

  async cleanup(input: { failed?: FinalVerificationDiagnosticsInput } = {}): Promise<{ diagnosticsPath?: string }> {
    if (this.completed) return {};
    const failures: unknown[] = [];
    try { await this.options.stopRun(this.options.runId); } catch (error) { failures.push(error); }
    try { await this.options.closeBrowserRun(this.options.runId); } catch (error) { failures.push(error); }
    let diagnosticsPath: string | undefined;
    if (input.failed) {
      if (!this.options.diagnostics) failures.push(new Error("Failed verification cleanup requires a diagnostics archive."));
      else {
        try { diagnosticsPath = await this.options.diagnostics.persist(input.failed); }
        catch (error) { failures.push(error); }
      }
    }
    if (failures.length === 0) {
      try { await this.options.workspaceManager.cleanup(); }
      catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      const detail = failures.slice(0, 10).map(errorMessage).join("; ").slice(0, 4_096);
      throw new AggregateError(
        failures,
        `Could not safely clean final verification for run ${this.options.runId}: ${detail}`,
      );
    }
    this.completed = true;
    return diagnosticsPath ? { diagnosticsPath } : {};
  }
}

function assertIdentity(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required for verification diagnostics.`);
}
function safeSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
function parseStatusPaths(status: string): string[] {
  const entries = status.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code.includes("R") || code.includes("C")) index += 1;
    paths.push(path);
  }
  return paths.sort((left, right) => left.localeCompare(right));
}
function redactAndBound(value: string): string {
  return value
    .replace(/\b(token|password|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s]+/gi, "$1=[REDACTED]")
    .slice(0, MAX_TEXT_BYTES);
}
function boundJson(value: readonly unknown[]): unknown[] {
  return value.slice(0, MAX_ITEMS).map((item) => {
    const encoded = redactAndBound(JSON.stringify(item));
    try { return JSON.parse(encoded) as unknown; }
    catch { return { truncated: true, preview: encoded }; }
  });
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
