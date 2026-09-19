import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { isExactPosixAnchorRelease } from "../src/portable-process-posix-control.mjs";
const source = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
function named(name: string): string {
  const start = source.indexOf(`function ${name}(`), end = source.indexOf("\nfunction ", start + 1);
  assert.ok(start >= 0 && end > start); return source.slice(start, end);
}
for (const mode of ["takeover", "coordination", "forged", "regressed"] as const)
test(`POSIX supervisor joins an already consumed anchor release under current ownership: ${mode}`, () => {
  const old = { ownerId: "original", fencingToken: 1 };
  let current = mode === "regressed" ? { ownerId: "foreign", fencingToken: 1 } : { ownerId: "takeover", fencingToken: 2 };
  const group = { groupId: 22, leaderPid: 22, leaderBirth: "exact-birth" };
  const release = { protocol: "aiboard-portable-process/v2-posix-anchor-release", nonce: "nonce", supervisorPid: 11, supervisorBirth: "supervisor-birth", ...old, workloadGroup: group };
  let busy = mode === "coordination";
  const context = { config: { nonce: "nonce" }, process: { pid: 11 }, posixWorkloadGroup: group,
    posixAnchorReleaseRequested: true, posixAnchorReleaseAuthority: old, posixSupervisorBirth: "supervisor-birth", posixChildReleasedAnchorRelease: null,
    isExactPosixAnchorRelease, anchorReleasePath: "release", readJson: () => mode === "forged" ? { ...release, supervisorBirth: "foreign" } : release,
    readCurrentFence: () => current, withCurrentFenceEffect: (ownerId: string, fencingToken: number, effect: () => unknown) => busy ? { status: "unavailable", cause: "coordination" } : ownerId === current.ownerId && fencingToken === current.fencingToken ? { status: "applied", value: effect() } : { status: "stale" },
    release, accepted: false,
  };
  runInNewContext(named("recordCausalPosixAnchorRelease") + "\naccepted = recordCausalPosixAnchorRelease(release);", context);
  assert.equal(context.accepted, mode === "takeover" ? "recorded" : mode === "coordination" ? "deferred" : "invalid");
  if (mode === "coordination") { busy = false; runInNewContext(named("recordCausalPosixAnchorRelease") + "\naccepted = recordCausalPosixAnchorRelease(release);", context); assert.equal(context.accepted, "recorded"); }
  if (mode === "forged" || mode === "regressed") assert.equal(context.posixChildReleasedAnchorRelease, null);
  current = { ownerId: "later", fencingToken: 3 };
});