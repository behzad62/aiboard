/**
 * The processes of CLI worker checks and Tests (docs/plans/2026-11-14-cli-workers.md §3.4, §3.11, packet CW3) run under
 * the same process ownership as a worker: a run binding of the execution host, whose managed processes run in the
 * Windows Job (when this host's Job containment is verified) or the POSIX process group under the portable supervisor,
 * with the host's batch-argv fact. Every process gets its own ToolBroker-shaped grant, and the session's stop is
 * `ManagedProcessService.closeAgent` for its owner, then the binding's own verified close.
 *
 * The binding is opened with `localMcpDepth: 1`, so every process it starts gets `AIBOARD_MCP_DEPTH=2`, as §3.11 sets
 * for a CLI: a user-configured `aiboard mcp serve` inside the CLI refuses with `local_mcp_recursion_limit`. It is a
 * transient binding: its run root and managed-process records are its own and go with it after a proven stop, so
 * repeated checks add nothing to the shared record store (whose 4096-record bound also holds every Build's processes).
 */

import { randomBytes, randomUUID } from "node:crypto";

import type { AgentActor, ToolExecutionContext } from "./agent-contracts.js";
import type { ExecutionHost, ExecutionHostRunBinding } from "./execution-host.js";
// One read is a page of at most ManagedProcessService's largest; a longer output is read over several reads.
import { MANAGED_OUTPUT_READ_MAX_BYTES, MANAGED_OUTPUT_WAIT_MAX_MS } from "./managed-process-contracts.js";
import type { ManagedProcessOwner } from "./managed-process-transport.js";
import type { RunnerCapabilitiesConfig } from "./runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "./runner-capability-contract.js";

/** What a read returned since the previous one. `exited`: the process ended and its output was read to the end. */
export interface CliWorkerProcessOutput {
  stdout: string;
  stderr: string;
  /**
   * Output that bounded live retention no longer held was skipped, so what came before this read's text is missing
   * (a CLI that printed more than the live tail before it was read: `codex debug models` prints about 0.8 MB at once).
   */
  gap: boolean;
  exited: boolean;
  exitCode: number | null;
}

export interface CliWorkerProcess {
  /** Writes `text` to stdin (when given) and closes it. */
  closeInput(text?: string): Promise<void>;
  /** Waits up to `waitMs` for new output and returns what arrived since the last read. */
  read(waitMs: number): Promise<CliWorkerProcessOutput>;
  /**
   * The next read starts again at the first byte. Once the process ended, its output is read from the finalized
   * record (managed-process-output.ts: the spill keeps up to 64 MiB a stream), so a probe whose live reads skipped a
   * stretch reads it whole.
   */
  rewind(): void;
}

export interface CliWorkerProcessSession {
  start(input: { executable: string; args: readonly string[] }): Promise<CliWorkerProcess>;
  /**
   * Stops every process this session started and everything they started, and proves it. Throws when the stop is not
   * proven; then nothing those processes could still be writing may be removed.
   */
  close(): Promise<void>;
}

export interface CliWorkerProcesses {
  /** A session whose processes run in `workingDirectory`, a Runner-owned folder. */
  open(input: { purpose: "check" | "test"; workingDirectory: string }): Promise<CliWorkerProcessSession>;
}

export interface ExecutionHostCliWorkerProcessesOptions {
  host: Pick<ExecutionHost, "bindRun">;
  capabilitiesConfig: () => RunnerCapabilitiesConfig;
  capabilityContract: () => Promise<RunnerCapabilityContract>;
}

/** Production: one execution-host run binding per check or Test, closed when the session closes. */
export function createExecutionHostCliWorkerProcesses(options: ExecutionHostCliWorkerProcessesOptions): CliWorkerProcesses {
  return Object.freeze({
    async open(input: { purpose: "check" | "test"; workingDirectory: string }): Promise<CliWorkerProcessSession> {
      const runId = `cli-worker-${input.purpose}-${randomBytes(6).toString("hex")}`;
      const binding = await options.host.bindRun({
        runId,
        permissionProfile: "full",
        capabilityContract: await options.capabilityContract(),
        capabilitiesConfig: options.capabilitiesConfig(),
        // §3.11: the CLI's children get AIBOARD_MCP_DEPTH=2, the local MCP door's limit.
        localMcpDepth: 1,
        // A check or Test leaves no history: its run root and process records live in their own folder, removed once
        // the binding's close proved every process stopped (execution-host.ts), never in the shared stores.
        transient: true,
      });
      return bindingSession(binding, runId, { role: "worker", id: `cli-worker-${input.purpose}` }, input.workingDirectory);
    },
  });
}

function bindingSession(binding: ExecutionHostRunBinding, runId: string, actor: AgentActor, workspacePath: string): CliWorkerProcessSession {
  const owner: ManagedProcessOwner = Object.freeze({ runId, sessionId: runId, actor: Object.freeze({ ...actor }) });
  const managed = binding.managedProcesses;
  let sequence = 0;
  let closed: Promise<void> | undefined;
  // Each managed call carries its own grant, as a ToolBroker call does, revoked after the call.
  const invoke = async <T>(toolName: string, perform: (context: ToolExecutionContext) => Promise<T>): Promise<T> => {
    const callId = `${runId}:${++sequence}:${toolName}`;
    const grant = await binding.executionGrants.issue({
      runId, sessionId: runId, actor: { ...actor }, toolName, callId, permissionProfile: "full", workspacePath,
      access: [{ path: workspacePath, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    try {
      return await perform({ runId, sessionId: runId, actor: { ...actor }, callId, toolName, workspacePath, executionGrant: grant });
    } finally {
      await binding.executionGrants.revoke(grant, "completed");
    }
  };
  return Object.freeze({
    async start(input: { executable: string; args: readonly string[] }): Promise<CliWorkerProcess> {
      const started = await invoke("process.start", (context) =>
        managed.start({ command: input.executable, args: [...input.args], cwd: ".", interactive: true }, context, workspacePath));
      const processId = started.processId;
      let cursor: string | undefined;
      return Object.freeze({
        async closeInput(text?: string) {
          await invoke("process.write_stdin", (context) =>
            managed.writeInput(processId, { writeId: randomUUID(), ...(text ? { data: text } : {}), closeInput: true }, context));
        },
        async read(waitMs: number): Promise<CliWorkerProcessOutput> {
          const result = await invoke("process.read_output", (context) =>
            managed.readOutput(processId, { ...(cursor ? { cursor } : {}), waitMs: Math.max(0, Math.min(Math.round(waitMs), MANAGED_OUTPUT_WAIT_MAX_MS)), maxBytes: MANAGED_OUTPUT_READ_MAX_BYTES }, context));
          cursor = result.cursor;
          let stdout = "", stderr = "", gap = false;
          for (const slice of result.slices) {
            if (slice.gap) gap = true;
            if (slice.stream === "stderr") stderr += slice.text;
            else stdout += slice.text;
          }
          return { stdout, stderr, gap, exited: result.status !== "running" && result.complete, exitCode: result.exitCode };
        },
        rewind() {
          cursor = undefined;
        },
      });
    },
    async close(): Promise<void> {
      closed ??= (async () => {
        const failures: unknown[] = [];
        try { await managed.closeAgent(owner); } catch (error) { failures.push(error); }
        // As git-bootstrap.ts: the binding's own close proves its runtime detached; one retry.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try { await binding.close(); break; } catch (error) { if (attempt === 1) failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, "CLI worker processes could not be proven stopped.");
      })();
      return await closed;
    },
  });
}
