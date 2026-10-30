// Observation only: what keeps this test process alive after a failed teardown. It never signals,
// waits on, or claims ownership of any process; PPID ancestry here is a diagnostic hint, not authority.
import { spawnSync } from "node:child_process";

export interface ResidueProcess { readonly pid: number; readonly parentPid: number; readonly name: string }
export interface ProcessResidue {
  readonly at: string;
  readonly pid: number;
  /** process.getActiveResourcesInfo() counted by resource type (for example ProcessWrap, PipeWrap, Timeout). */
  readonly activeResources: Readonly<Record<string, number>>;
  /** Live descendants of this process by PPID at capture time, or why they could not be listed. */
  readonly descendants: readonly ResidueProcess[] | { readonly unavailable: string };
}

function processTable(): readonly ResidueProcess[] {
  const result = process.platform === "win32"
    ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)\" }"],
    { encoding: "utf8", timeout: 20_000, windowsHide: true })
    : spawnSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8", timeout: 20_000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `exit ${result.status}: ${String(result.stderr).trim().slice(0, 200)}`);
  return String(result.stdout).split(/\r?\n/).flatMap((line) => {
    const match = process.platform === "win32" ? /^(\d+)\t(\d+)\t(.*)$/.exec(line.trim()) : /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), name: match[3]!.trim() }] : [];
  });
}

export function descendantsOf(root: number, table: readonly ResidueProcess[]): ResidueProcess[] {
  const found: ResidueProcess[] = [];
  const frontier = [root];
  while (frontier.length && found.length < 256) {
    const parent = frontier.shift()!;
    for (const entry of table) {
      if (entry.parentPid === parent && entry.pid !== root && !found.some((seen) => seen.pid === entry.pid)) {
        found.push(entry);
        frontier.push(entry.pid);
      }
    }
  }
  return found;
}

export function captureProcessResidue(): ProcessResidue {
  const activeResources: Record<string, number> = {};
  for (const resource of process.getActiveResourcesInfo()) activeResources[resource] = (activeResources[resource] ?? 0) + 1;
  let descendants: ProcessResidue["descendants"];
  try {
    // The table query's own child has exited before parsing, so it is never reported as residue.
    descendants = descendantsOf(process.pid, processTable());
  } catch (error) {
    descendants = { unavailable: error instanceof Error ? error.message : String(error) };
  }
  return { at: new Date().toISOString(), pid: process.pid, activeResources, descendants };
}

/**
 * Writes the residue now, and again after each delay while this process is still alive. The timers
 * are unref'd, so they never keep the process alive themselves.
 */
export function reportProcessResidue(label: string, write: (line: string) => void, laterMs: readonly number[] = [60_000, 300_000]): void {
  const emit = (when: string) => {
    try { write(`${JSON.stringify({ residue: label, when, ...captureProcessResidue() })}\n`); }
    catch { /* best-effort diagnostics */ }
  };
  emit("teardown");
  for (const delay of laterMs) setTimeout(() => emit(`+${Math.round(delay / 1000)}s`), delay).unref();
}
