import { execFileSync, spawnSync } from "node:child_process";
// RUNNER_RAW_PROCESS_BOUNDARY: POSIX process/group identity inspection for owned-tree lifecycle enforcement.
import { readFileSync, readdirSync, statSync } from "node:fs";

const POSIX_INSPECTION_DEADLINE_MS = 15_000;
const POSIX_CPU_INSPECTION_DEADLINE_MS = 2_000;
const POSIX_CPU_SAMPLE_INTERVAL_MS = process.platform === "linux" ? 250 : 500;
const POSIX_CPU_RETRY_INTERVAL_MS = 1_000;
const POSIX_PREPARED_PROTOCOL = "aiboard-portable-process/v2-posix-prepared";
const POSIX_GO_PROTOCOL = "aiboard-portable-process/v2-posix-go";
const POSIX_ANCHOR_RELEASE_PROTOCOL = "aiboard-portable-process/v2-posix-anchor-release";

export function parseLinuxProcStatIdentity(pid, stat) {
  if (!positivePid(pid) || typeof stat !== "string") return undefined;
  const close = stat.lastIndexOf(")");
  const prefix = /^\s*(\d+)\s+\(/.exec(stat.slice(0, close + 1));
  if (close < 1 || !prefix || Number(prefix[1]) !== pid) return undefined;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  // Linux /proc/<pid>/stat is: state, ppid, pgrp, ... starttime (field 22).
  const groupId = Number(fields[2]);
  const startTime = fields[19];
  if (!positivePid(groupId) || !/^\d+$/.test(startTime ?? "")) return undefined;
  return { pid, groupId, birth: `proc-start:${startTime}` };
}

export function inspectPosixProcessIdentity(pid) {
  if (!positivePid(pid)) return { state: "unknown" };
  if (process.platform === "linux") {
    try {
      const value = parseLinuxProcStatIdentity(pid, readFileSync(`/proc/${pid}/stat`, "utf8"));
      return value ? { state: "present", value } : { state: "unknown" };
    } catch (error) {
      return error?.code === "ENOENT" ? { state: "absent" } : { state: "unknown" };
    }
  }
  try {
    const row = execFileSync("ps", ["-o", "pid=,pgid=,lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: POSIX_INSPECTION_DEADLINE_MS,
    }).trim();
    if (!row) return { state: "absent" };
    const value = parsePosixPsIdentity(pid, row);
    return value ? { state: "present", value } : { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

export function parsePosixPsIdentity(pid, row) {
  if (!positivePid(pid) || typeof row !== "string") return undefined;
  const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(row.trim());
  if (!match || Number(match[1]) !== pid || !positivePid(Number(match[2])) || !match[3]) return undefined;
  // Match native-process-backend's non-Linux `ps -o lstart=` fingerprint exactly.
  return { pid, groupId: Number(match[2]), birth: match[3] };
}

export function listOwnedPosixGroupMembers(groupId) {
  if (!positivePid(groupId)) return undefined;
  try {
    return parsePosixGroupMembers(execFileSync("ps", ["-e", "-o", "pid=,pgid=,stat="], {
      encoding: "utf8",
      timeout: POSIX_INSPECTION_DEADLINE_MS,
    }), groupId);
  } catch {
    return undefined;
  }
}

export function parsePosixGroupMembers(output, groupId) {
  if (!positivePid(groupId) || typeof output !== "string") return undefined;
  const members = [];
  let sawSnapshotRow = false;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(-?\d+)\s+(-?\d+)\s+(\S+)$/.exec(trimmed);
    if (!match) return undefined;
    sawSnapshotRow = true;
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    const state = match[3];
    // The first ps state character is the execution state; remaining BSD
    // modifiers describe priority/session/foreground attributes. Linux extra
    // flags are <NLsl+; Darwin also documents >AESVWX. Darwin first-state
    // letters come from Apple ps mach_state_table " RUSITH?" (R,U,S,I,T,H,?)
    // plus BSD SSTOP/SZOMB T/Z. Refuse an unknown token rather than guessing
    // whether that process can execute. A foreign documented Mach/BSD state
    // must not void an otherwise exact owned-group snapshot.
    if (!/^[DRSTtXxIZUH?][<NLsl+>AESVWX]*$/.test(state)) return undefined;
    // Linux kernel threads report a positive PID with pgid 0. Only that row
    // is skipped; pid 0 or any other non-positive identity fails closed.
    if (positivePid(pid) && pgid === 0) continue;
    if (!positivePid(pid) || !positivePid(pgid)) return undefined;
    // A zombie has already exited and cannot execute or receive a signal. Its
    // unreaped pid/pgid row is not live workload membership.
    if (state.startsWith("Z")) continue;
    if (pgid === groupId) members.push(pid);
  }
  // A successful `ps -e` snapshot necessarily contains at least its own row.
  // Blank output is therefore unavailable evidence, never exact emptiness.
  return sawSnapshotRow ? members : undefined;
}

/**
 * VF7b: a read-only table of every visible process (pid, group, birth, uid and full command line), for the
 * Playwright CLI session's attributable-browser check after a managed stop. Each row's group and birth come from
 * the same read as its command line (Linux: /proc stat, cmdline, stat again; elsewhere one `ps -A -ww`), so a
 * reused PID never carries another process's command line. No parent PIDs: nothing here derives ownership from
 * ancestry. Undefined when no snapshot could be read: callers treat that as unknown, never as empty.
 */
export function listPosixProcessCommands() {
  if (process.platform === "linux") {
    let entries;
    try { entries = readdirSync("/proc"); } catch { return undefined; }
    const rows = [];
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        // A zombie has exited: it cannot run or hold a browser, and only waits for its parent to reap it.
        if (linuxProcState(stat) === "Z") continue;
        const first = parseLinuxProcStatIdentity(pid, stat);
        const uid = statSync(`/proc/${entry}`).uid;
        const command = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
        const second = parseLinuxProcStatIdentity(pid, readFileSync(`/proc/${entry}/stat`, "utf8"));
        if (first && second && first.birth === second.birth && first.groupId === second.groupId) {
          rows.push({ pid, groupId: first.groupId, birth: first.birth, uid, command });
        }
      } catch { /* exited while listing */ }
    }
    return rows.length > 0 ? rows : undefined;
  }
  try {
    return parsePosixPsCommands(execFileSync("ps", ["-A", "-ww", "-o", "pid=,pgid=,uid=,stat=,lstart=,command="], {
      encoding: "utf8",
      timeout: POSIX_CPU_INSPECTION_DEADLINE_MS,
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch {
    return undefined;
  }
}

/**
 * `ps -o pid=,pgid=,uid=,stat=,lstart=,command=` rows, zombies left out; lstart is the same fingerprint as
 * inspectPosixProcessIdentity's.
 */
export function parsePosixPsCommands(output) {
  if (typeof output !== "string") return undefined;
  const rows = [];
  let sawRow = false;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})(?:\s(.*))?$/.exec(line);
    if (!match) return undefined;
    sawRow = true;
    if (match[4].startsWith("Z")) continue;
    rows.push({ pid: Number(match[1]), groupId: Number(match[2]), uid: Number(match[3]), birth: match[5], command: match[6] ?? "" });
  }
  return sawRow ? rows : undefined;
}

function linuxProcState(stat) {
  const close = typeof stat === "string" ? stat.lastIndexOf(")") : -1;
  return close < 0 ? undefined : stat.slice(close + 1).trim().split(/\s+/)[0];
}

/**
 * VF7b: the identities of several PIDs in one bounded read (Linux: their /proc stat; elsewhere one `ps -p a,b,c`
 * with a 2 s limit). A PID the snapshot does not show is absent, and so is a zombie (it has exited: it cannot run
 * and only waits for its parent to reap it); an unreadable snapshot makes every one unknown.
 */
export function inspectPosixProcessIdentities(pids) {
  const result = new Map();
  const wanted = [...new Set(pids)].filter(positivePid);
  if (wanted.length === 0) return result;
  if (process.platform === "linux") {
    for (const pid of wanted) {
      let stat;
      try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); }
      catch (error) { result.set(pid, error?.code === "ENOENT" ? { state: "absent" } : { state: "unknown" }); continue; }
      const value = parseLinuxProcStatIdentity(pid, stat);
      result.set(pid, linuxProcState(stat) === "Z" ? { state: "absent" } : value ? { state: "present", value } : { state: "unknown" });
    }
    return result;
  }
  const ran = spawnSync("ps", ["-o", "pid=,pgid=,stat=,lstart=", "-p", wanted.join(",")], { encoding: "utf8", timeout: POSIX_CPU_INSPECTION_DEADLINE_MS });
  // ps exits 1 when a listed PID is gone; it still prints the others.
  if (ran.error || (ran.status !== 0 && ran.status !== 1) || typeof ran.stdout !== "string") {
    for (const pid of wanted) result.set(pid, { state: "unknown" });
    return result;
  }
  const seen = new Map();
  for (const line of ran.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    const pid = Number(match?.[1]);
    if (!match || !positivePid(pid)) continue;
    const value = parsePosixPsIdentity(pid, `${match[1]} ${match[2]} ${match[4].trim()}`);
    seen.set(pid, match[3].startsWith("Z") ? { state: "absent" } : value ? { state: "present", value } : { state: "unknown" });
  }
  for (const pid of wanted) result.set(pid, seen.get(pid) ?? (ran.status === 0 && seen.size === 0 ? { state: "unknown" } : { state: "absent" }));
  return result;
}

export function reattestOwnedPosixAnchor(workloadGroup, inspect = inspectPosixProcessIdentity, listMembers = listOwnedPosixGroupMembers) {
  if (!validWorkloadGroup(workloadGroup)) return { state: "identity_mismatch" };
  const inspection = inspect(workloadGroup.leaderPid);
  if (inspection?.state === "unknown" || inspection?.state === "absent") return { state: "outcome_unknown" };
  if (inspection?.state !== "present" || !inspection.value || inspection.value.pid !== workloadGroup.leaderPid ||
      inspection.value.groupId !== workloadGroup.groupId || inspection.value.birth !== workloadGroup.leaderBirth)
    return { state: "identity_mismatch" };
  const members = listMembers(workloadGroup.groupId);
  if (!Array.isArray(members) || !members.every(positivePid) || !members.includes(workloadGroup.leaderPid))
    return { state: "outcome_unknown" };
  return { state: "ready", members: [...members] };
}

export function reattestOwnedPosixDescendants(
  workloadGroup,
  recordedMembers,
  inspect = inspectPosixProcessIdentity,
  listMembers = listOwnedPosixGroupMembers,
) {
  if (!validWorkloadGroup(workloadGroup) || !(recordedMembers instanceof Map) || recordedMembers.size < 1)
    return { state: "identity_mismatch" };
  for (const [pid, birth] of recordedMembers) {
    if (!positivePid(pid) || typeof birth !== "string" || birth.length === 0) return { state: "identity_mismatch" };
  }
  const members = listMembers(workloadGroup.groupId);
  if (!Array.isArray(members) || !members.every(positivePid)) return { state: "outcome_unknown" };
  if (members.length === 0) return { state: "empty" };
  let proven = 0;
  let liveListed = 0;
  for (const pid of members) {
    const inspection = inspect(pid);
    if (inspection?.state === "unknown") return { state: "outcome_unknown" };
    // A PID can leave the group between `ps` and inspect. That is emptiness,
    // not proof that a recycled group now occupies the numeric PGID.
    if (inspection?.state === "absent") continue;
    liveListed += 1;
    const recordedBirth = recordedMembers.get(pid);
    if (typeof recordedBirth !== "string" || recordedBirth.length === 0) continue;
    if (inspection?.state !== "present" || !inspection.value || inspection.value.pid !== pid ||
        inspection.value.groupId !== workloadGroup.groupId || inspection.value.birth !== recordedBirth)
      return { state: "identity_mismatch" };
    proven += 1;
  }
  if (liveListed < 1) return { state: "empty" };
  if (proven < 1) return { state: "identity_mismatch" };
  return { state: "ready", members: [...members] };
}

export function parsePosixBootstrapPrepared(value, nonce, expectedLeaderPid) {
  if (!record(value) || value.protocol !== POSIX_PREPARED_PROTOCOL || value.nonce !== nonce || !positivePid(expectedLeaderPid)) return undefined;
  const workloadGroup = { groupId: value.groupId, leaderPid: value.leaderPid, leaderBirth: value.leaderBirth };
  return validWorkloadGroup(workloadGroup) && workloadGroup.leaderPid === expectedLeaderPid ? workloadGroup : undefined;
}

export function parsePosixBootstrapGo(value, nonce, workloadGroup) {
  if (!record(value) || value.protocol !== POSIX_GO_PROTOCOL || value.nonce !== nonce || !sameWorkloadGroup(value.workloadGroup, workloadGroup) ||
      !positivePid(value.supervisorPid) || typeof value.supervisorBirth !== "string" || value.supervisorBirth.length === 0 ||
      typeof value.ownerId !== "string" || value.ownerId.length === 0 || !positiveFence(value.fencingToken)) return undefined;
  return { supervisorPid: value.supervisorPid, supervisorBirth: value.supervisorBirth };
}

export function isExactPosixAnchorRelease(value, nonce, workloadGroup, expectedSupervisor, currentFence) {
  return !!record(value) && value.protocol === POSIX_ANCHOR_RELEASE_PROTOCOL && value.nonce === nonce &&
    sameWorkloadGroup(value.workloadGroup, workloadGroup) && positivePid(value.supervisorPid) &&
    typeof value.supervisorBirth === "string" && value.supervisorBirth.length > 0 &&
    sameSupervisorAuthority(value, expectedSupervisor) && typeof value.ownerId === "string" && value.ownerId.length > 0 &&
    positiveFence(value.fencingToken) && sameFenceAuthority(value, currentFence);
}

export function signalOwnedPosixGroup(action, signal = process.kill, groupId) {
  if (!positivePid(groupId)) throw new Error("Owned POSIX workload group identity is invalid.");
  const osSignal = action === "force_terminate" ? "SIGKILL" : "SIGTERM";
  try {
    signal(-groupId, osSignal);
  } catch (error) {
    // The kernel reports ESRCH when the recorded group has no remaining
    // members. That is applied control, not lost fence authority: treating it
    // as a throw crashes the supervisor before it can retire the workload.
    if (error?.code !== "ESRCH") throw error;
  }
}

/** Group and CPU (own plus reaped children's, in clock ticks) from Linux /proc/<pid>/stat. */
export function parseLinuxProcStatCpu(pid, stat) {
  if (!positivePid(pid) || typeof stat !== "string") return undefined;
  const close = stat.lastIndexOf(")");
  const prefix = /^\s*(\d+)\s+\(/.exec(stat.slice(0, close + 1));
  if (close < 1 || !prefix || Number(prefix[1]) !== pid) return undefined;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  // Fields 14-17 of the stat line: utime, stime, cutime, cstime. The child times are signed in the kernel ABI.
  const times = fields.slice(11, 15);
  const groupId = Number(fields[2]);
  if (!positivePid(groupId) || times.length !== 4 || !times.every((value) => /^-?\d+$/.test(value))) return undefined;
  return { groupId, ticks: times.reduce((sum, value) => sum + Math.max(0, Number(value)), 0) };
}

/** `ps -o time=` as milliseconds: [dd-][hh:]mm:ss[.cc]. BSD reports centiseconds, procps whole seconds. */
export function parsePosixCpuClock(value) {
  const match = typeof value === "string" ? /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2})(?:\.(\d{1,3}))?$/.exec(value) : null;
  if (!match) return undefined;
  const fraction = Number((match[5] ?? "").padEnd(3, "0"));
  const total = (Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 3_600_000 + Number(match[3]) * 60_000 + Number(match[4]) * 1_000 + fraction;
  return Number.isSafeInteger(total) ? total : undefined;
}

/** Rows of `ps -o pid=,pgid=,time=`; only the group's own rows count. Anything malformed voids the sample. */
export function parsePosixPsCpu(output, groupId) {
  if (typeof output !== "string" || !positivePid(groupId)) return undefined;
  const readings = new Map();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    const cpuMs = match ? parsePosixCpuClock(match[3]) : undefined;
    if (cpuMs === undefined || !positivePid(Number(match[1]))) return undefined;
    if (Number(match[2]) === groupId) readings.set(Number(match[1]), cpuMs);
  }
  return readings;
}

let linuxClockTicksPerSecond;
function linuxClockTicks() {
  if (linuxClockTicksPerSecond) return linuxClockTicksPerSecond;
  const value = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: POSIX_CPU_INSPECTION_DEADLINE_MS }).trim());
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Linux clock tick rate is unavailable.");
  linuxClockTicksPerSecond = value;
  return value;
}

export function readLinuxProcCpu(pids, groupId, readStat = (pid) => readFileSync(`/proc/${pid}/stat`, "utf8"), ticksPerSecond = linuxClockTicks) {
  const readings = new Map();
  if (pids.length === 0) return readings;
  const hz = ticksPerSecond();
  for (const pid of pids) {
    let stat;
    try { stat = readStat(pid); }
    catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") continue; // exited since the membership snapshot
      throw error;
    }
    const parsed = parseLinuxProcStatCpu(pid, stat);
    if (!parsed) return undefined;
    if (parsed.groupId === groupId) readings.set(pid, Math.floor(parsed.ticks * 1_000 / hz));
  }
  return readings;
}

export function readPosixPsCpu(pids, groupId) {
  if (pids.length === 0) return new Map();
  const result = spawnSync("ps", ["-o", "pid=,pgid=,time=", "-p", pids.join(",")], { encoding: "utf8", timeout: POSIX_CPU_INSPECTION_DEADLINE_MS });
  const stdout = String(result.stdout ?? "");
  // ps exits 1 with no output at all when every listed PID has already gone.
  const allGone = result.status === 1 && !stdout.trim() && !String(result.stderr ?? "").trim();
  if (result.error || (result.status !== 0 && !allGone)) return undefined;
  return parsePosixPsCpu(stdout, groupId);
}

export function readOwnedPosixCpu(pids, groupId) {
  return process.platform === "linux" ? readLinuxProcCpu(pids, groupId) : readPosixPsCpu(pids, groupId);
}

/**
 * T1 CPU evidence for one owned workload group, fed the membership the supervisor already attested.
 * Read-only and never a lifecycle fact: a failed read publishes nothing (the reader then sees stale,
 * then absent, evidence), and a failed publication only turns sampling off.
 *
 * The group's leader is the Runner's own anchor, a Node process that polls on a timer. Its startup
 * and polling aren't workload CPU, so it is excluded. The total only ever grows, like Job accounting:
 * each PID contributes its own growth, so a member's exit can't hide a sibling's work.
 * A child's time can count twice, once sampled and again in its parent's reaped-children time. That
 * errs toward "busy", the safe direction for a wait. Scope is the process group, the POSIX ownership
 * model: a descendant that moves to its own group is outside it, and so is its CPU.
 */
export function createPosixCpuSampler({ groupId, leaderPid, publish, read = readOwnedPosixCpu, now = Date.now, intervalMs = POSIX_CPU_SAMPLE_INTERVAL_MS }) {
  let totalMs = 0, nextAt = 0, stopped = false;
  let last = new Map();
  return Object.freeze({
    tick(members) {
      if (stopped) return;
      const at = now();
      if (at < nextAt) return;
      let readings;
      try { readings = read(members.filter((pid) => pid !== leaderPid), groupId); } catch { readings = undefined; }
      if (!readings) { nextAt = at + POSIX_CPU_RETRY_INTERVAL_MS; return; }
      nextAt = at + intervalMs;
      for (const [pid, cpuMs] of readings) totalMs += Math.max(0, cpuMs - (last.get(pid) ?? 0));
      last = readings;
      // Stamped before the reads: every value in this sample was read at or after sampledAt.
      try { publish({ cpuTimeMs: totalMs, sampledAt: new Date(at).toISOString() }); }
      catch { stopped = true; }
    },
  });
}

function validWorkloadGroup(value) {
  return !!value && typeof value === "object" && positivePid(value.groupId) && value.groupId === value.leaderPid &&
    positivePid(value.leaderPid) && typeof value.leaderBirth === "string" && value.leaderBirth.length > 0;
}
function sameWorkloadGroup(left, right) {
  return validWorkloadGroup(left) && validWorkloadGroup(right) && left.groupId === right.groupId &&
    left.leaderPid === right.leaderPid && left.leaderBirth === right.leaderBirth;
}
function sameSupervisorAuthority(value, expected) {
  return !!expected && positivePid(expected.supervisorPid) && typeof expected.supervisorBirth === "string" && expected.supervisorBirth.length > 0 &&
    value.supervisorPid === expected.supervisorPid && value.supervisorBirth === expected.supervisorBirth;
}
function sameFenceAuthority(value, current) {
  return !!current && typeof current.ownerId === "string" && current.ownerId.length > 0 && positiveFence(current.fencingToken) &&
    value.ownerId === current.ownerId && value.fencingToken === current.fencingToken;
}
function record(value) { return !!value && typeof value === "object"; }
function positiveFence(value) { return Number.isSafeInteger(value) && value >= 1; }
function positivePid(value) { return Number.isSafeInteger(value) && value > 0; }
