import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { LocalMcpSessions } from "../src/local-stdio-mcp.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { CONTAINED_STOP_CONFIRMATION, PROCESS_GROUP_STOP_CONFIRMATION, stopConfirmation } from "../src/managed-process-tools.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";

/**
 * The native POSIX backend owns a process group (docs/runner-v2/posix-detached-descendants.md). A child that calls
 * setsid, as Node's `detached: true` does, leaves that group at birth: the Runner neither waits for it nor stops it.
 * This pins that limitation on Linux, and that a verified stop says only what the group proves. It is the spike's
 * `control-detached` scenario (playwright-cli-spike-2026-11-13.md §4). The fixture cleans up its own escaped child,
 * by the PID and birth it first saw, whose command line names this test's marker file.
 */
type Block = { type: string; text?: string; value?: Record<string, unknown> };
type Result = { content: Block[]; isError?: boolean; error?: { code: string; message: string } };
const metadata = (result: Result): Record<string, unknown> => {
  const block = result.content.find((entry) => entry.type === "json"); assert.ok(block?.value, JSON.stringify(result)); return block.value;
};

/** Starts a child in its own session that writes its PID to the marker and sleeps; the parent exits at once, or stays with "stay". */
const DETACH = `import { spawn } from "node:child_process";
const [marker, mode] = process.argv.slice(2);
const child = spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 30000)", marker], { detached: true, stdio: "ignore" });
child.unref();
if (mode === "stay") { process.stdout.write("ready\\n"); setInterval(() => {}, 1000); }
`;

type EscapedChild = { pid: number; birth: string; sessionId: number; groupId: number };

/** The child named by the marker, alive and not a zombie, read from /proc: birth is its start time (stat field 22). */
function escapedChild(marker: string): EscapedChild | undefined {
  if (!existsSync(marker)) return undefined;
  const pid = Number(readFileSync(marker, "utf8"));
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(marker)) return undefined;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u);
    if (fields[0] === "Z") return undefined;
    return { pid, birth: fields[19]!, groupId: Number(fields[2]), sessionId: Number(fields[3]) };
  } catch { return undefined; }
}

/** First sight of each child, so cleanup kills only that PID with that birth. */
const firstSeen = new Map<string, EscapedChild>();

async function waitForEscapedChild(marker: string): Promise<EscapedChild> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const child = escapedChild(marker);
    if (child) { firstSeen.set(marker, child); return child; }
    if (Date.now() >= deadline) throw new Error(`the detached child never wrote ${marker}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Still the same process: same PID and the same birth as when the test first saw it. */
function sameEscapedChild(marker: string): boolean {
  const seen = firstSeen.get(marker), now = escapedChild(marker);
  return !!seen && !!now && now.pid === seen.pid && now.birth === seen.birth;
}

/** A child seen before stops only if it is still that PID and birth; one never seen (a failure came first) is taken at this sight. */
function stopEscapedChild(marker: string): void {
  if (!firstSeen.has(marker)) { const now = escapedChild(marker); if (now) firstSeen.set(marker, now); }
  if (sameEscapedChild(marker)) process.kill(firstSeen.get(marker)!.pid, "SIGKILL");
}

test("POSIX: a detached child leaves the owned group, outlives its process_run and process_start, and a stop claims only the group", {
  skip: process.platform !== "linux" && "The escape is POSIX behaviour, checked here on Linux through /proc; Windows Jobs hold detached children.",
  timeout: 60_000,
}, async (t) => {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".posix-escape-"));
  const project = join(root, "project"), state = join(root, "state");
  await mkdir(project); await mkdir(state);
  await writeFile(join(project, "detach.mjs"), DETACH);
  const markers = [join(project, "run.pid"), join(project, "start.pid")];
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  const sessions = new LocalMcpSessions({ host, workspacePath: project, statePath: join(state, "owners.sqlite"), permissionProfile: "full", capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
  await sessions.recover();
  const owner = sessions.mint(0);
  let key = 0;
  const call = async (name: string, args: Record<string, unknown>): Promise<Result> =>
    await sessions.perform(owner.token, { operation: "call", name, arguments: { ...args, ...(["process_run", "process_start", "process_signal"].includes(name) ? { idempotencyKey: `key-${++key}` } : {}) } }) as Result;
  try {
    // process_run ends when its group is empty, so it does not wait for the child that left it.
    const began = Date.now();
    const run = await call("process_run", { command: process.execPath, args: ["detach.mjs", markers[0]], timeoutMs: 25_000 });
    const ranFor = Date.now() - began;
    assert.equal(run.isError, false, JSON.stringify(run));
    assert.equal(metadata(run).exitCode, 0);
    assert.ok(ranFor < 20_000, `the call waited ${ranFor} ms, as if it owned the 30 s child`);
    const fromRun = await waitForEscapedChild(markers[0]);
    assert.equal(fromRun.sessionId, fromRun.pid, "the child leads a session of its own");
    assert.equal(fromRun.groupId, fromRun.pid, "and a process group of its own");
    assert.ok(sameEscapedChild(markers[0]), "the detached child outlives its process_run");
    t.diagnostic(`process_run returned in ${ranFor} ms; detached child ${fromRun.pid} (pgid ${fromRun.groupId}, sid ${fromRun.sessionId}) still running`);

    // A managed process: the stop is verified for the group, and the child in its own session survives it.
    const started = await call("process_start", { command: process.execPath, args: ["detach.mjs", markers[1], "stay"], until: { pattern: "ready" }, waitMs: 20_000 });
    assert.equal(started.isError, false, JSON.stringify(started));
    const processId = metadata(started).processId as string;
    const fromStart = await waitForEscapedChild(markers[1]);
    const stopped = await call("process_signal", { processId, signal: "SIGTERM" });
    assert.equal(stopped.isError, false, JSON.stringify(stopped));
    assert.equal(metadata(stopped).status, "stopped");
    const confirmed = String(metadata(stopped).confirmed);
    assert.equal(confirmed, PROCESS_GROUP_STOP_CONFIRMATION, "the stop names the scope it proved, and what it does not cover");
    assert.ok(sameEscapedChild(markers[1]), "the detached child outlives its managed process's verified stop");
    t.diagnostic(`process_signal stopped ${processId}; detached child ${fromStart.pid} still running`);
  } finally {
    for (const marker of markers) stopEscapedChild(marker);
    owner.revoke();
    await sessions.close(); await host.close(); await rm(root, { recursive: true, force: true });
  }
});

test("a verified stop claims the whole tree only when its backend attested a contained workload", () => {
  assert.equal(stopConfirmation("contained_workload"), CONTAINED_STOP_CONFIRMATION);
  assert.match(CONTAINED_STOP_CONFIRMATION, /every process it started have exited.*No further check is needed/u);
  // A process group (POSIX, or Windows without a Job) and a binding with no scope prove only the group.
  for (const scope of ["process_group", undefined] as const) assert.equal(stopConfirmation(scope), PROCESS_GROUP_STOP_CONFIRMATION);
  assert.match(PROCESS_GROUP_STOP_CONFIRMATION, /every process still in its process group have exited/u);
  assert.match(PROCESS_GROUP_STOP_CONFIRMATION, /setsid, setpgid, or spawn with detached: true\) is not covered/u);
  assert.doesNotMatch(PROCESS_GROUP_STOP_CONFIRMATION, /port \w+ listened on is closed|No further check/u, "a group stop cannot close a port a leaver inherited");
});
