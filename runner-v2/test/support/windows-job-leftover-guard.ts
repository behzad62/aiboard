// PX-2e — shared end-of-file guard for the Windows Job real-host test files.
//
// Two helpers, no product code:
// - checkNoWindowsJobProcessesLeft: an `after()` hook asserting that no
//   supervisor (node running managed-process-supervisor.mjs) or Job host
//   (powershell.exe under such a supervisor) started by the file is still
//   alive. Attribution is by command line plus process tree: the supervisor
//   command line carries this worktree's runner-v2/src path plus the file's
//   own temp roots, AND the process must descend from the calling test
//   process (parent-PID chain). The tree check is what excludes concurrent
//   or earlier runs of the same file (same prefix family, different process
//   tree) and other runs' supervisors in this worktree, so the check never
//   sees other worktrees, other files, or other runs. An empty marker list
//   is rejected outright: it would degenerate to a worktree-wide match.
//   Leftovers are killed only after the failure is recorded.
// - retireOwnedTreeForTests: best-effort teardown for a raw-host call that
//   follows the designed path (signal, drain retained output with exact
//   ACKs, release). A plain signal+release is refused by design while
//   retained output is unacknowledged (exited_unknown with pending output),
//   and the supervisor parks in that state forever, so tests that assert on
//   unsettled states must drain before release or leak one supervisor per
//   run. Never throws.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  WindowsJobOwnershipKey,
  WindowsJobProcessHost,
  WindowsJobWriterFence,
} from "../../src/windows-job-process-host.js";

interface ListedProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly commandLine: string;
}

function normalizeCommandLine(value: string): string {
  return value.toLowerCase().replace(/\\/g, "/");
}

// This worktree's runner-v2/src directory, derived from this helper's own
// location. A supervisor command line carries the supervisor script path,
// so requiring this marker excludes supervisors from other worktrees,
// checkouts, and lanes on a shared machine.
function worktreeSrcMarker(): string {
  const supportDir = dirname(fileURLToPath(import.meta.url));
  return normalizeCommandLine(join(supportDir, "..", "..", "src"));
}

function listNodeAndPowershell(): ListedProcess[] {
  const script = [
    "Get-CimInstance Win32_Process",
    "| Where-Object { $_.Name -eq 'node.exe' -or $_.Name -eq 'powershell.exe' }",
    "| Select-Object ProcessId, ParentProcessId, Name, CommandLine",
    "| ConvertTo-Json -Compress",
  ].join(" ");
  // Repair cycle 1 (N2): enumeration must fail closed. Every failure mode
  // below throws, so the end check reports "could not enumerate" instead of
  // passing vacuously over an empty list.
  let stdout: string;
  try {
    stdout = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
  } catch (error) {
    throw new Error(
      `PX-2e leftover guard: could not enumerate processes (${error instanceof Error ? error.message : String(error)}). ` +
        "Failing closed: treating this as a leftover risk, not a pass.",
    );
  }
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(
      "PX-2e leftover guard: could not enumerate processes (empty process list). " +
        "Failing closed: treating this as a leftover risk, not a pass.",
    );
  }
  let rows: Array<{ ProcessId?: number; ParentProcessId?: number; Name?: string; CommandLine?: string | null }>;
  try {
    const parsed = JSON.parse(trimmed) as
      | { ProcessId?: number; ParentProcessId?: number; Name?: string; CommandLine?: string | null }
      | Array<{ ProcessId?: number; ParentProcessId?: number; Name?: string; CommandLine?: string | null }>;
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    throw new Error(
      `PX-2e leftover guard: could not enumerate processes (unparseable list: ${error instanceof Error ? error.message : String(error)}). ` +
        "Failing closed: treating this as a leftover risk, not a pass.",
    );
  }
  const listed = rows
    .filter((row) => Number.isSafeInteger(row.ProcessId))
    .map((row) => ({
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId ?? 0),
      name: String(row.Name ?? ""),
      commandLine: String(row.CommandLine ?? ""),
    }));
  // The calling test process itself is a node.exe row in this listing. If it
  // is missing, the enumeration is untrustworthy and a pass would be vacuous.
  if (!listed.some((row) => row.pid === process.pid)) {
    throw new Error(
      "PX-2e leftover guard: could not enumerate processes (own test process missing from the list). " +
        "Failing closed: treating this as a leftover risk, not a pass.",
    );
  }
  return listed;
}

// Repair cycle 1 (B1, N1): a candidate only counts when its parent-PID chain
// reaches the calling test process. Same-prefix supervisors from a
// concurrent or earlier run of the same file live in a different process
// tree, so markers alone would match them; the tree check excludes them.
function isInOwnProcessTree(
  proc: ListedProcess,
  ownPid: number,
  byPid: Map<number, ListedProcess>,
): boolean {
  let current: ListedProcess | undefined = proc;
  const seen = new Set<number>();
  while (current && !seen.has(current.pid)) {
    if (current.ppid === ownPid) return true;
    seen.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return false;
}

function findOwned(
  processes: ListedProcess[],
  srcMarker: string,
  fileMarkers: readonly string[],
  ownPid: number,
): { supervisors: ListedProcess[]; jobHosts: ListedProcess[] } {
  const normalizedMarkers = fileMarkers.map((marker) => marker.toLowerCase());
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const supervisors = processes.filter((proc) => {
    if (proc.name.toLowerCase() !== "node.exe") return false;
    const command = normalizeCommandLine(proc.commandLine);
    if (!command.includes("managed-process-supervisor.mjs")) return false;
    if (!command.includes(srcMarker)) return false;
    if (!normalizedMarkers.some((marker) => command.includes(marker))) return false;
    return isInOwnProcessTree(proc, ownPid, byPid);
  });
  const supervisorPids = new Set(supervisors.map((proc) => proc.pid));
  const jobHosts = processes.filter((proc) => {
    if (proc.name.toLowerCase() !== "powershell.exe") return false;
    if (!isInOwnProcessTree(proc, ownPid, byPid)) return false;
    const command = normalizeCommandLine(proc.commandLine);
    if (normalizedMarkers.some((marker) => command.includes(marker))) return true;
    let current: ListedProcess | undefined = proc;
    const seen = new Set<number>();
    while (current && !seen.has(current.ppid)) {
      seen.add(current.pid);
      if (supervisorPids.has(current.ppid)) return true;
      current = byPid.get(current.ppid);
    }
    return false;
  });
  return { supervisors, jobHosts };
}

function killProcess(pid: number): string {
  try {
    process.kill(pid, "SIGKILL");
    return "SIGKILL-sent";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ESRCH/i.test(message)) return "already-dead";
  }
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore", timeout: 30_000 });
    return "taskkill-sent";
  } catch (error) {
    return `kill-failed:${error instanceof Error ? error.message : String(error)}`;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * End-of-file check for the Windows Job real-host test files. Fails the file
 * when a supervisor or Job host it started is still alive: matched processes
 * get a grace window to exit on their own (a stopped supervisor exits
 * itself, and `after` hooks may run in either order), and anything still
 * alive afterwards is recorded, killed, and reported.
 */
export async function checkNoWindowsJobProcessesLeft(
  fileMarkers: readonly string[],
  options: { readonly graceMs?: number } = {},
): Promise<void> {
  // Repair cycle 1 (B1): reject an empty marker list at registration. The old
  // code treated `[]` as "any supervisor from this worktree", so a file with
  // no markers of its own failed on other runs' live supervisors and killed
  // them. Fixture-only files must scope to their own process tree or a
  // marker that cannot match another run instead.
  if (fileMarkers.length === 0) {
    throw new Error(
      "PX-2e leftover guard: checkNoWindowsJobProcessesLeft requires at least one file marker; " +
        "an empty list would match every supervisor from this worktree, including other runs'.",
    );
  }
  if (process.platform !== "win32") return;
  const srcMarker = worktreeSrcMarker();
  const ownPid = process.pid;
  const graceMs = options.graceMs ?? 10_000;
  const deadline = Date.now() + graceMs;
  let owned = findOwned(listNodeAndPowershell(), srcMarker, fileMarkers, ownPid);
  while ((owned.supervisors.length > 0 || owned.jobHosts.length > 0) && Date.now() < deadline) {
    await sleep(1000);
    owned = findOwned(listNodeAndPowershell(), srcMarker, fileMarkers, ownPid);
  }
  if (owned.supervisors.length === 0 && owned.jobHosts.length === 0) return;
  const recorded = [...owned.jobHosts, ...owned.supervisors]
    .map((proc) => `pid=${proc.pid} ppid=${proc.ppid} ${proc.name} :: ${proc.commandLine}`)
    .join("\n");
  // Recorded above; only now remove them so a later run starts clean.
  const kills = [...owned.jobHosts, ...owned.supervisors].map(
    (proc) => `pid=${proc.pid}:${killProcess(proc.pid)}`,
  );
  await sleep(2000);
  const remaining = findOwned(listNodeAndPowershell(), srcMarker, fileMarkers, ownPid);
  const stillAlive = [...remaining.jobHosts, ...remaining.supervisors].map((proc) => proc.pid);
  throw new Error(
    `PX-2e leftover guard: ${owned.supervisors.length} supervisor(s) and ` +
      `${owned.jobHosts.length} Job host(s) started by this file were still alive at file end:\n` +
      `${recorded}\nkill: ${kills.join(", ")}` +
      (stillAlive.length > 0 ? `\nstill alive after kill: ${stillAlive.join(", ")}` : "\nall leftovers confirmed dead after kill"),
  );
}

/**
 * Best-effort teardown for one raw-host call. Follows the designed path so a
 * call that ends with unacknowledged retained output (exited_unknown with
 * pending output) still retires: signal the tree, drain retained output with
 * exact ACKs until the supervisor reaches stopped and exits itself, then
 * release. Never throws; failures are for the end-of-file guard to report.
 */
export async function retireOwnedTreeForTests(
  service: WindowsJobProcessHost,
  input: {
    readonly processId: string;
    readonly owner: WindowsJobOwnershipKey;
    readonly fence: WindowsJobWriterFence;
    readonly startedAt: string;
  },
): Promise<void> {
  const fence = { ...input.fence };
  try {
    await service.signalOwned(input.processId, "SIGKILL", input.owner, fence);
  } catch {
    // Already terminal, or refused while retained output is unsettled; the
    // drain below handles the unsettled shape. The tree itself is dead or
    // was already empty in every case that reaches here.
  }
  try {
    // acknowledgeOwnedOutput is optional on the interface (fakes may omit
    // it); without it there is no drain path, so fall through to release.
    const acknowledge = service.acknowledgeOwnedOutput;
    if (typeof acknowledge === "function") {
      // Bound: the method uses `this` (fence effects, record cache).
      const ack = acknowledge.bind(service);
      const offsets = { stdout: 0, stderr: 0 };
      for (let round = 0; round < 10; round += 1) {
        const read = await service.readOwnedOutput(input.processId, input.owner, { ...offsets }, { ...fence });
        let advanced = false;
        for (const stream of ["stdout", "stderr"] as const) {
          if (read.next[stream] > offsets[stream]) {
            await ack(input.processId, input.owner, { ...fence }, stream, read.next[stream]);
            offsets[stream] = read.next[stream];
            advanced = true;
          }
        }
        if (!advanced) break;
      }
    }
  } catch {
    // Already released, supervisor already gone, or nothing retained.
  }
  try {
    await service.releaseOwned(input.processId, input.owner, input.startedAt, fence);
  } catch {
    // Best-effort cleanup only.
  }
}
