import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { NativeOwnedProcessBackend } from "../src/native-process-backend.js";
import { createPosixProcessBackend } from "../src/posix-process-backend.js";
import {
  createPosixCpuSampler,
  parseLinuxProcStatCpu,
  parsePosixCpuClock,
  parsePosixPsCpu,
  readLinuxProcCpu,
  readPosixPsCpu,
  type PosixCpuSample,
} from "../src/portable-process-posix-control.mjs";
import { parseProcessLaunchResult, parseProcessUsage, ProcessReleasePendingError, type ProcessLaunchResult } from "../src/process-backend.js";

// T1 POSIX CPU evidence (docs/plans/2026-11-03-remote-t1-interaction-ux.md §7). The pure rules run
// everywhere; the real-process cases need a POSIX host.
const posix = process.platform !== "win32";
const STAT_TAIL = "0 0 0 0 0 0 0 20 0 1 0 12345 1000 10";
const statLine = (pid: number, comm: string, group: number, utime: number, stime: number, cutime = 0, cstime = 0) =>
  `${pid} (${comm}) S 1 ${group} ${group} 0 -1 4194304 10 0 0 0 ${utime} ${stime} ${cutime} ${cstime} ${STAT_TAIL}\n`;

test("Linux stat parsing sums own and reaped-children CPU, whatever the command name holds", () => {
  assert.deepEqual(parseLinuxProcStatCpu(41, statLine(41, "node", 40, 7, 3, 20, 5)), { groupId: 40, ticks: 35 });
  assert.deepEqual(parseLinuxProcStatCpu(41, statLine(41, "a) b (c", 40, 1, 2)), { groupId: 40, ticks: 3 }, "a command name can hold spaces and parentheses");
  assert.deepEqual(parseLinuxProcStatCpu(41, statLine(41, "node", 40, 1, 2, -9, 4)), { groupId: 40, ticks: 7 }, "child times are signed in the ABI and never subtract");
});

test("Linux stat parsing refuses anything it can't prove", () => {
  assert.equal(parseLinuxProcStatCpu(42, statLine(41, "node", 40, 1, 2)), undefined, "another process's line");
  assert.equal(parseLinuxProcStatCpu(41, "41 (node) S 1 40"), undefined, "truncated before the CPU fields");
  assert.equal(parseLinuxProcStatCpu(41, statLine(41, "node", 40, 1, 2).replace(" 1 2 0 0 ", " 1 x 0 0 ")), undefined, "non-numeric CPU field");
  assert.equal(parseLinuxProcStatCpu(41, "garbage"), undefined);
});

test("ps CPU clocks parse in both the BSD and procps forms", () => {
  for (const [value, ms] of [
    ["0:00.03", 30], ["0:01.50", 1_500], ["12:34.56", 754_560], ["123:45.67", 7_425_670],
    ["00:00:05", 5_000], ["01:02:03", 3_723_000], ["2-01:00:00", 176_400_000], ["1:02:03.5", 3_723_500],
  ] as const) assert.equal(parsePosixCpuClock(value), ms, value);
  for (const value of ["", "abc", "12", "1:2", "-1:00", "0:00.1234"]) assert.equal(parsePosixCpuClock(value), undefined, value);
});

test("ps CPU rows keep only the group's own members, and a malformed row voids the sample", () => {
  assert.deepEqual([...parsePosixPsCpu("  41    40   0:01.00\n  77    70   9:00.00\n\n", 40)!], [[41, 1_000]], "a member that left the group no longer counts");
  assert.deepEqual([...parsePosixPsCpu("", 40)!], []);
  assert.equal(parsePosixPsCpu("41 40 what\n", 40), undefined);
  assert.equal(parsePosixPsCpu("41 40\n", 40), undefined);
  assert.equal(parsePosixPsCpu("0 40 0:01.00\n", 40), undefined);
});

test("reading /proc skips exited members, drops strays and fails closed on anything else", () => {
  const stats = new Map([[41, statLine(41, "a", 40, 100, 50)], [42, statLine(42, "b", 99, 7, 7)]]);
  const read = (pid: number) => {
    const stat = stats.get(pid);
    if (stat !== undefined) return stat;
    throw Object.assign(new Error("gone"), { code: pid === 43 ? "ENOENT" : "ESRCH" });
  };
  assert.deepEqual([...readLinuxProcCpu([41, 42, 43, 44], 40, read, () => 100)!], [[41, 1_500]]);
  assert.deepEqual([...readLinuxProcCpu([41], 40, read, () => 250)!], [[41, 600]], "ticks scale by the host's clock rate");
  assert.equal(readLinuxProcCpu([41], 40, () => "not a stat line", () => 100), undefined);
  assert.throws(() => readLinuxProcCpu([41], 40, () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }, () => 100), /denied/);
  assert.deepEqual([...readLinuxProcCpu([], 40, read, () => { throw new Error("must not be consulted"); })!], []);
});

function harness(readings: () => ReadonlyMap<number, number> | undefined) {
  const samples: PosixCpuSample[] = [];
  let now = 1_000;
  const reads: (readonly number[])[] = [];
  const sampler = createPosixCpuSampler({
    groupId: 40, leaderPid: 40, intervalMs: 250, now: () => now,
    publish: sample => { samples.push(sample); },
    read: pids => { reads.push(pids); return readings(); },
  });
  return { sampler, samples, reads, at: (value: number) => { now = value; } };
}

test("the sampler never counts the anchor and honors its cadence", () => {
  const h = harness(() => new Map([[41, 10]]));
  h.sampler.tick([40, 41]);
  assert.deepEqual(h.reads, [[41]], "the Runner's own polling anchor is not workload CPU");
  h.at(1_249); h.sampler.tick([40, 41]);
  assert.equal(h.samples.length, 1, "at most one sample per interval");
  h.at(1_250); h.sampler.tick([40, 41]);
  assert.deepEqual(h.samples, [
    { cpuTimeMs: 10, sampledAt: new Date(1_000).toISOString() },
    { cpuTimeMs: 10, sampledAt: new Date(1_250).toISOString() },
  ], "flat CPU still refreshes sampledAt");
});

test("the total never falls: a member's exit can't hide a sibling's work", () => {
  const steps: ReadonlyMap<number, number>[] = [
    new Map([[41, 5_000], [42, 100]]),
    new Map([[42, 100]]), // 41, the heavy member, exits
    new Map([[42, 400]]), // the survivor keeps working
    new Map([[42, 400], [43, 50]]), // a new member counts from its own start
  ];
  let i = 0;
  const h = harness(() => steps[i++]);
  for (const [index, at] of [1_000, 1_250, 1_500, 1_750].entries()) { h.at(at); h.sampler.tick([40, 41, 42, 43]); assert.equal(h.samples.length, index + 1); }
  assert.deepEqual(h.samples.map(sample => sample.cpuTimeMs), [5_100, 5_100, 5_400, 5_450]);
});

test("a failed read publishes nothing and keeps its place; only publication failure stops sampling", () => {
  let readings: ReadonlyMap<number, number> | undefined = new Map([[41, 100]]);
  const h = harness(() => readings);
  h.sampler.tick([41]);
  readings = undefined;
  h.at(1_250); h.sampler.tick([41]);
  assert.equal(h.samples.length, 1, "unreadable evidence is not republished as flat");
  h.at(1_500); h.sampler.tick([41]);
  assert.equal(h.reads.length, 2, "a failed read backs off");
  readings = new Map([[41, 300]]);
  h.at(2_250); h.sampler.tick([41]);
  assert.equal(h.samples.at(-1)!.cpuTimeMs, 300, "CPU spent during the failure is still counted");

  let reads = 0;
  const thrown = createPosixCpuSampler({ groupId: 40, leaderPid: 40, publish: () => assert.fail("nothing to publish"), read: () => { reads += 1; throw new Error("boom"); }, now: () => 0 });
  assert.doesNotThrow(() => thrown.tick([41]), "a read failure must never reach the supervisor's lifecycle tick");
  assert.equal(reads, 1);

  let publishes = 0, now = 0;
  const broken = createPosixCpuSampler({ groupId: 40, leaderPid: 40, intervalMs: 1, now: () => now++, read: () => new Map(), publish: () => { publishes += 1; throw new Error("disk full"); } });
  assert.doesNotThrow(() => broken.tick([41]), "a publication failure must never reach the supervisor's lifecycle tick");
  broken.tick([41]);
  assert.equal(publishes, 1, "publication failure turns sampling off");
});

function usageBinding(directory: string, nonce = "nonce-1") {
  const group = { groupId: 40, leaderPid: 40, leaderBirth: "anchor" };
  const identity = { version: 2, backendId: "runner-posix-process-group-v1", nonce, directory, supervisorPid: 9001, supervisorBirth: "supervisor", workloadGroup: group };
  return {
    registryId: "registry", backendId: identity.backendId, implementationGeneration: "generation", implementationDigest: "1".repeat(64),
    attestationVersion: 1, attestationDigest: "2".repeat(64),
    opaqueIdentity: Buffer.from(JSON.stringify(identity)).toString("base64url"),
    birthFingerprint: { observedAt: "2026-11-04T00:00:00.000Z", discriminator: createHash("sha256").update(`${nonce}\0supervisor\0${group.groupId}\0${group.leaderPid}\0${group.leaderBirth}`).digest("hex") },
    rootPid: 9001, startedAt: "2026-11-04T00:00:00.000Z",
  };
}

test("backend usage reports only fresh evidence of this launch; anything else is honestly absent", async t => {
  const root = mkdtempSync(join(tmpdir(), "posix-usage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state"), directory = join(root, "owned");
  mkdirSync(directory);
  const backend = createPosixProcessBackend({ stateDirectory: state });
  const binding = usageBinding(directory);
  const usage = () => backend.usage(binding as never);
  const write = (value: unknown) => writeFileSync(join(directory, "usage.json"), typeof value === "string" ? value : JSON.stringify(value));

  assert.equal(await usage(), undefined, "no sample yet");
  const fresh = new Date().toISOString();
  write({ nonce: "nonce-1", cpuTimeMs: 120, sampledAt: fresh });
  assert.deepEqual(await usage(), { cpuTimeMs: 120, sampledAt: fresh, steady: true });
  assert.deepEqual(parseProcessUsage(await usage()), { cpuTimeMs: 120, sampledAt: fresh, steady: true });
  write({ nonce: "other", cpuTimeMs: 120, sampledAt: fresh });
  assert.equal(await usage(), undefined, "another launch's evidence");
  write({ nonce: "nonce-1", cpuTimeMs: 120, sampledAt: new Date(Date.now() - 60_000).toISOString() });
  assert.equal(await usage(), undefined, "a frozen total must not read as flat CPU");
  write({ nonce: "nonce-1", cpuTimeMs: 120, sampledAt: "soon" });
  assert.equal(await usage(), undefined);
  write("{ torn");
  assert.equal(await usage(), undefined);
  write({ nonce: "nonce-1", cpuTimeMs: "many", sampledAt: fresh });
  assert.equal(parseProcessUsage(await usage()), undefined, "the shared parser drops a malformed value");
  assert.equal(await backend.usage({ ...binding, opaqueIdentity: "bad" } as never), undefined);

  write({ nonce: "nonce-1", cpuTimeMs: 120, sampledAt: fresh });
  const portable = new NativeOwnedProcessBackend({ stateDirectory: state, platform: "windows", backendId: "runner-posix-process-group-v1", lifecycleScope: "process_group", capabilities: {} as never, operations: {} as never });
  assert.equal(await portable.usage(binding as never), undefined, "the portable Windows backend keeps its own evidence rules");
});

const fence = Object.freeze({ ownerId: "owner", fencingToken: 1 });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type UsageSample = { cpuTimeMs: number; sampledAt: string };
async function withWorkload(t: TestContext, script: string, body: (f: { usage: () => Promise<UsageSample | undefined>; nextSample: () => Promise<UsageSample>; directory: string }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "posix-usage-live-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
  const backend = createPosixProcessBackend({ stateDirectory: root });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => ["path", "tmp", "temp", "tmpdir"].includes(key.toLowerCase()) && value !== undefined)) as Record<string, string>;
  const launch: ProcessLaunchResult = parseProcessLaunchResult(await backend.launch({
    intent: { invocationId: "usage", runId: "run", kind: "command", executable: process.execPath, arguments: ["-e", script], workingDirectory: root, requiredLifecycleScope: "process_group", requestedCapabilities: [] },
    grant: { grantId: "grant", runId: "run", invocationId: "usage", issuedAt: new Date().toISOString(), access: [] },
    environment, outputOwnerId: "output", fence,
  } as never));
  const binding = { registryId: "registry", backendId: "runner-posix-process-group-v1", implementationGeneration: "generation", implementationDigest: "1".repeat(64), attestationVersion: 1, attestationDigest: "2".repeat(64), ...launch };
  const usage = async () => await backend.usage(binding as never) as UsageSample | undefined;
  const { directory } = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory: string };
  const nextSample = async () => {
    const before = (await usage())?.sampledAt;
    for (const deadline = Date.now() + 10_000; Date.now() < deadline; await sleep(20)) {
      const sample = await usage();
      if (sample && sample.sampledAt !== before) return sample;
    }
    throw new Error("no CPU sample within 10 s");
  };
  try { await body({ usage, nextSample, directory }); }
  finally {
    await backend.signal(binding as never, "force_terminate", fence);
    for (const deadline = Date.now() + 10_000;;) {
      try { await backend.release(binding as never, fence); break; }
      catch (error) {
        if (!(error instanceof ProcessReleasePendingError) || Date.now() >= deadline) throw error;
        await sleep(20);
      }
    }
  }
}
const posixOnly = { timeout: 60_000, skip: posix ? false : "POSIX supervisor only" };

test("a sleeping workload is flat even though the anchor keeps polling, and evidence stays out of the lifecycle status", posixOnly, async t => withWorkload(t, "setInterval(() => {}, 1000)", async f => {
  await sleep(1_000); // the workload's own startup
  const state = () => JSON.parse(readFileSync(join(f.directory, "state.json"), "utf8")) as Record<string, unknown>;
  const revision = state().revision;
  const first = await f.nextSample();
  await sleep(2_000);
  const second = await f.nextSample();
  const windowMs = Date.parse(second.sampledAt) - Date.parse(first.sampledAt);
  assert.ok(second.cpuTimeMs - first.cpuTimeMs <= 0.02 * windowMs, `flat workload charged ${second.cpuTimeMs - first.cpuTimeMs} ms over ${windowMs} ms`);
  assert.equal(state().revision, revision, "sampling must not touch the lifecycle status line");
  assert.doesNotMatch(JSON.stringify(state()), /cpu/i);
}));

test("a busy workload's CPU grows at about one core", posixOnly, async t => withWorkload(t, "for (;;) Math.sqrt(Math.random())", async f => {
  const first = await f.nextSample();
  await sleep(1_500);
  const second = await f.nextSample();
  const windowMs = Date.parse(second.sampledAt) - Date.parse(first.sampledAt);
  assert.ok(second.cpuTimeMs - first.cpuTimeMs >= 0.5 * windowMs, `busy workload charged ${second.cpuTimeMs - first.cpuTimeMs} ms over ${windowMs} ms`);
}));

test("CPU of a descendant in the group counts, and its exit never lowers the total", posixOnly, async t => withWorkload(t,
  `const { spawn } = require('node:child_process');
   spawn(process.execPath, ['-e', 'const end = Date.now() + 1500; while (Date.now() < end);'], { stdio: 'ignore' });
   setInterval(() => {}, 1000);`, async f => {
    const totals: number[] = [];
    for (const deadline = Date.now() + 3_500; Date.now() < deadline;) totals.push((await f.nextSample()).cpuTimeMs);
    assert.deepEqual(totals, [...totals].sort((a, b) => a - b), "the total never falls");
    assert.ok(totals.at(-1)! - totals[0]! >= 500, `descendant work not counted: ${totals.join(",")}`);
  }));

test("both real readers see a busy process in its own group", posixOnly, async t => {
  const child = spawn(process.execPath, ["-e", "for (;;) Math.sqrt(Math.random())"], { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } });
  await sleep(1_500);
  const ps = readPosixPsCpu([child.pid!], child.pid!);
  assert.ok((ps?.get(child.pid!) ?? 0) >= 500 || process.platform === "linux", `ps saw ${ps?.get(child.pid!)}`);
  assert.equal(ps?.has(child.pid!), true);
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  assert.deepEqual([...readPosixPsCpu([gone], child.pid!)!], [], "every listed PID gone is an empty reading, not a failure");
  assert.deepEqual([...readPosixPsCpu([child.pid!], child.pid! + 1)!], [], "a member outside the group doesn't count");
  if (process.platform === "linux") assert.ok((readLinuxProcCpu([child.pid!], child.pid!)?.get(child.pid!) ?? 0) >= 500);
});
