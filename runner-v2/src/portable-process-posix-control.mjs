import { execFileSync } from "node:child_process";
// RUNNER_RAW_PROCESS_BOUNDARY: POSIX process/group identity inspection for owned-tree lifecycle enforcement.
import { readFileSync } from "node:fs";

const POSIX_INSPECTION_DEADLINE_MS = 15_000;
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
    // flags are <NLsl+; Darwin also documents >AESVWX. Refuse an unknown
    // token rather than guessing whether that process can execute. A foreign
    // documented modifier must not void an otherwise exact owned-group snapshot.
    if (!/^[DRSTtXxIZU][<NLsl+>AESVWX]*$/.test(state)) return undefined;
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
