// The Windows birth helper is compiled into helper.exe on the user's machine with Windows' own C# compiler; no binary
// ships. These tests drive the real compile, placement, session and owner, and the fail-closed paths around them.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { WindowsBirthInspectionOwner } from "../src/windows-birth-inspection.mjs";
import { provideWindowsBirthHelperAssembly, resetWindowsBirthHelperBuildsForTests, WINDOWS_BIRTH_HELPER_COMPILE_FLAGS } from "../src/windows-job-process-host.js";

const windows = process.platform === "win32";
const source = readFileSync(new URL("../src/windows-birth/helper-live.cs", import.meta.url));
const sourceSha256 = createHash("sha256").update(source).digest("hex");
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function stateDirectory(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-birth-assembly-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function prepared(owner: WindowsBirthInspectionOwner): Promise<() => Promise<void>> {
  let cleanup: ((deadline?: number) => Promise<void>) | undefined;
  owner.registerCleanup((duty) => { cleanup = duty; });
  await owner.prepareInspection(Date.now() + 30_000);
  return async () => { await cleanup!(Date.now() + 5_000); };
}

function messages(error: unknown): string[] {
  const found: string[] = [];
  const visit = (current: unknown): void => {
    if (!current || typeof current !== "object") return;
    const value = current as { message?: string; cause?: unknown; errors?: unknown[] };
    found.push(String(value.message));
    for (const nested of value.errors ?? []) visit(nested);
    visit(value.cause);
  };
  visit(error);
  return found;
}

test("the helper compiles locally into an exe, is placed canonically in the state directory, and is reused there", { skip: !windows }, async (t) => {
  const state = stateDirectory(t);
  const first = await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  assert.equal(first.sourceSha256, sourceSha256);
  assert.ok(first.path.startsWith(realpathSync.native(state)), "placed under the backend state directory");
  assert.equal(realpathSync.native(first.path), first.path, "the placed path is already canonical");
  assert.ok(first.path.endsWith("\\helper.exe"));
  assert.deepEqual(readdirSync(dirname(first.path)), ["helper.exe"], "the digest directory holds only the helper");
  const image = readFileSync(first.path);
  assert.equal(image.subarray(0, 2).toString("latin1"), "MZ", "a Windows program");
  assert.equal(image.readUInt16LE(image.readInt32LE(0x3c) + 0x5c), 2, "a windowless (GUI subsystem) program, never a console");
  assert.equal(sha(readFileSync(first.path)), first.sha256);
  const again = await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  assert.deepEqual(again, first, "one compile per process and source, one placed file per state directory");
  writeFileSync(first.path, Buffer.from("not the helper"));
  const repaired = await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  assert.equal(sha(readFileSync(repaired.path)), first.sha256, "a changed placed file is replaced by the build's bytes");
  // A second link to the right bytes would be refused by the session on every prepare: placement replaces it.
  const second = join(state, "second-link.exe");
  linkSync(first.path, second);
  assert.equal(statSync(first.path).nlink, 2);
  await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  assert.equal(statSync(first.path).nlink, 1);
  assert.equal(sha(readFileSync(first.path)), first.sha256);
  assert.deepEqual(readdirSync(dirname(first.path)), ["helper.exe"]);
});

// Windows' compiler gives every compile a new digest, so an unchanged digest after a reset proves no compile ran.
const REUSE = { reuseRecorded: true } as const;
const SCHEMA = "aiboard-windows-birth-helper-record-v1";
const recordsIn = (placed: { path: string }): string[] =>
  readdirSync(dirname(dirname(placed.path))).filter((name) => /^build-[0-9a-f]{16}\.json$/.test(name));
const recordOf = (placed: { path: string }): string => {
  const records = recordsIn(placed);
  assert.equal(records.length, 1, `one build record: ${records.join(", ")}`);
  return join(dirname(dirname(placed.path)), records[0]!);
};
const readRecord = (placed: { path: string }): Record<string, unknown> => JSON.parse(readFileSync(recordOf(placed), "utf8"));
const digestDirectories = (placed: { path: string }): string[] => readdirSync(dirname(dirname(placed.path))).filter((name) => /^[0-9a-f]{16}$/.test(name));

test("a later Runner start uses the recorded helper without compiling it again", { skip: !windows }, async (t) => {
  const state = stateDirectory(t);
  const first = await provideWindowsBirthHelperAssembly(state, source, sourceSha256, REUSE);
  const record = readRecord(first);
  assert.deepEqual(Object.keys(record).sort(), ["recipeSha256", "schema", "sha256", "sourceSha256"]);
  assert.equal(record.schema, SCHEMA);
  assert.equal(record.sourceSha256, sourceSha256);
  assert.equal(record.sha256, first.sha256);
  assert.match(String(record.recipeSha256), /^[0-9a-f]{64}$/);
  resetWindowsBirthHelperBuildsForTests();
  const second = await provideWindowsBirthHelperAssembly(state, source, sourceSha256, REUSE);
  assert.deepEqual(second, first, "the recorded exe, with no new compile");
  assert.deepEqual(digestDirectories(first), [first.sha256.slice(0, 16)], "no second copy");
});

test("without reuse, as for a backend with no Runner helper directory, nothing is recorded or reused", { skip: !windows }, async (t) => {
  const state = stateDirectory(t);
  const first = await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  assert.deepEqual(recordsIn(first), []);
  resetWindowsBirthHelperBuildsForTests();
  const second = await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  assert.notEqual(second.sha256, first.sha256, "compiled again");
  // A record and its intact exe planted in such a directory are never read: only an opted-in caller would use them.
  resetWindowsBirthHelperBuildsForTests();
  const planted = await provideWindowsBirthHelperAssembly(stateDirectory(t), source, sourceSha256, REUSE);
  const birth = dirname(dirname(second.path));
  writeFileSync(join(birth, basename(recordOf(planted))), readFileSync(recordOf(planted)));
  mkdirSync(join(birth, planted.sha256.slice(0, 16)));
  writeFileSync(join(birth, planted.sha256.slice(0, 16), "helper.exe"), readFileSync(planted.path));
  resetWindowsBirthHelperBuildsForTests();
  const third = await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  assert.notEqual(third.sha256, planted.sha256, "not the planted exe");
  assert.notEqual(third.sha256, second.sha256, "compiled again");
  resetWindowsBirthHelperBuildsForTests();
  assert.equal((await provideWindowsBirthHelperAssembly(state, source, sourceSha256, REUSE)).sha256, planted.sha256,
    "the planted pair is valid: an opted-in caller would reuse it");
});

test("a recorded helper that changed or went missing is compiled again into a new directory and recorded", { skip: !windows }, async (t) => {
  const state = stateDirectory(t);
  const first = await provideWindowsBirthHelperAssembly(state, source, sourceSha256, REUSE);
  writeFileSync(first.path, Buffer.from("not the helper"));
  resetWindowsBirthHelperBuildsForTests();
  const second = await provideWindowsBirthHelperAssembly(state, source, sourceSha256, REUSE);
  assert.notEqual(second.sha256, first.sha256);
  assert.notEqual(dirname(second.path), dirname(first.path), "a new directory, never the old exe a supervisor may still run");
  assert.equal(readFileSync(first.path, "utf8"), "not the helper", "the old directory is left as it was");
  assert.equal(readRecord(second).sha256, second.sha256);
  rmSync(second.path);
  resetWindowsBirthHelperBuildsForTests();
  const third = await provideWindowsBirthHelperAssembly(state, source, sourceSha256, REUSE);
  assert.notEqual(third.sha256, second.sha256);
  assert.equal(sha(readFileSync(third.path)), third.sha256);
  assert.equal(readRecord(third).sha256, third.sha256);
});

test("a missing, malformed, foreign or oversized record, or a sidecar beside the recorded exe, means a new compile", { skip: !windows }, async (t) => {
  const state = stateDirectory(t);
  let current = await provideWindowsBirthHelperAssembly(state, source, sourceSha256, REUSE);
  const record = recordOf(current);
  const valid = (): Record<string, unknown> => JSON.parse(readFileSync(record, "utf8"));
  const cases: Array<[string, () => void]> = [
    ["missing", () => rmSync(record)],
    ["malformed", () => writeFileSync(record, "{")],
    ["another source", () => writeFileSync(record, JSON.stringify({ ...valid(), sourceSha256: "1".repeat(64) }))],
    ["another recipe", () => writeFileSync(record, JSON.stringify({ ...valid(), recipeSha256: "2".repeat(64) }))],
    ["another schema", () => writeFileSync(record, JSON.stringify({ ...valid(), schema: "aiboard-windows-birth-helper-record-v0" }))],
    ["extra fields", () => writeFileSync(record, JSON.stringify({ ...valid(), path: "C:\\x\\helper.exe" }))],
    ["oversized", () => writeFileSync(record, JSON.stringify({ ...valid() }) + " ".repeat(5_000))],
    ["a sidecar", () => writeFileSync(join(dirname(current.path), "helper.exe.config"), "")],
  ];
  for (const [name, damage] of cases) {
    damage();
    resetWindowsBirthHelperBuildsForTests();
    const next = await provideWindowsBirthHelperAssembly(state, source, sourceSha256, REUSE);
    assert.notEqual(next.sha256, current.sha256, name);
    const rewritten = valid();
    assert.equal(rewritten.sha256, next.sha256, name);
    assert.equal(rewritten.sourceSha256, sourceSha256, name);
    assert.equal(rewritten.schema, SCHEMA, name);
    current = next;
  }
});

test("a source that does not match its pin is never compiled", { skip: !windows }, async (t) => {
  const state = stateDirectory(t);
  await assert.rejects(provideWindowsBirthHelperAssembly(state, source, "0".repeat(64)), /does not match its pin/);
  await assert.rejects(provideWindowsBirthHelperAssembly(state, Buffer.from("class X {}"), sourceSha256), /does not match its pin/);
});

test("a failed compile is remembered for the process, never retried", { skip: !windows }, async (t) => {
  const state = stateDirectory(t);
  const broken = Buffer.from(`class Broken { int }\n// ${randomBytes(8).toString("hex")}\n`);
  const pin = sha(broken);
  const first = await provideWindowsBirthHelperAssembly(state, broken, pin).then(() => undefined, (error: unknown) => error);
  assert.ok(first instanceof Error && /compile failed/.test(first.message), String(first));
  const second = await provideWindowsBirthHelperAssembly(state, broken, pin).then(() => undefined, (error: unknown) => error);
  assert.equal(second, first, "the same failure, with no second compile");
});

test("the source stays warning-free on Windows' own compiler", { skip: !windows }, async (t) => {
  // The runtime compile does not treat warnings as errors (a framework update must not stop inspection); this does.
  const directory = stateDirectory(t);
  const sourcePath = join(directory, "helper-live.cs");
  writeFileSync(sourcePath, source);
  const result = spawnSync("C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe", [
    ...WINDOWS_BIRTH_HELPER_COMPILE_FLAGS, "/warnaserror+", `/out:${join(directory, "helper.exe")}`, sourcePath,
  ], { encoding: "utf8", windowsHide: true, cwd: "C:\\Windows\\System32" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(`${result.stdout}${result.stderr}`.trim(), "");
});

test("the helper is placed only on a local drive, by a path short enough to start, with no link in it", { skip: !windows }, async (t) => {
  const state = stateDirectory(t);
  // 260 characters or more is refused, not left to whether long paths are enabled.
  const deep = join(state, "d".repeat(230));
  await assert.rejects(provideWindowsBirthHelperAssembly(deep, source, sourceSha256), /too long to start/);
  // A share is refused, as the loader refuses an installation on one.
  const share = `\\\\localhost\\${state[0]}$${state.slice(2)}`;
  if (existsSync(share)) await assert.rejects(provideWindowsBirthHelperAssembly(join(share, "share-state"), source, sourceSha256), /must be on a local drive/);
  else t.diagnostic(`administrative share ${share} is not reachable; the loader's share refusal is still covered`);
  // A digest directory that is a junction to another copy of the right bytes is refused, here and by the session.
  const placed = await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  const elsewhere = join(state, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "helper.exe"), readFileSync(placed.path));
  rmSync(dirname(placed.path), { recursive: true, force: true });
  symlinkSync(elsewhere, dirname(placed.path), "junction");
  await assert.rejects(provideWindowsBirthHelperAssembly(state, source, sourceSha256), /not canonical/);
  const owner = new WindowsBirthInspectionOwner(undefined, { assembly: async () => placed });
  await assert.rejects(prepared(owner), (error: unknown) => messages(error).some((message) => /alias|substitution/.test(message)));
  assert.equal(owner.assembly(), null);
  unlinkSync(dirname(placed.path));
});

test("preparation fails closed without a matching helper", { skip: !windows }, async (t) => {
  const state = stateDirectory(t);
  const placed = await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  for (const [name, assembly] of [
    ["missing", async () => undefined],
    ["null", async () => null],
    ["another source", async () => ({ ...placed, sourceSha256: "1".repeat(64) })],
    ["extra fields", async () => ({ ...placed, extra: true })],
    ["another file name", async () => ({ ...placed, path: placed.path.replace(/helper\.exe$/, "other.exe") })],
    ["a share", async () => ({ ...placed, path: `\\\\localhost\\share${placed.path.slice(2)}` })],
  ] as const) {
    const owner = new WindowsBirthInspectionOwner(undefined, { assembly: assembly as never });
    await assert.rejects(prepared(owner), /does not match its pinned source/, name);
    assert.equal(owner.assembly(), null, name);
  }
});

test("a helper changed after placement is refused before it starts", { skip: !windows }, async (t) => {
  const state = stateDirectory(t);
  const placed = await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  writeFileSync(placed.path, Buffer.concat([readFileSync(placed.path), Buffer.from([0])]));
  const owner = new WindowsBirthInspectionOwner(undefined, { assembly: async () => placed });
  // Preparation fails on the digest, and its cleanup's own re-check of the file fails too.
  await assert.rejects(prepared(owner), (error: unknown) => messages(error).includes("Binary descriptor digest"));
  assert.equal(owner.assembly(), null);
});

test("a configuration or other sidecar beside the helper fails closed, in placement and in preparation", { skip: !windows }, async (t) => {
  const state = stateDirectory(t);
  const placed = await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  for (const sidecar of ["helper.exe.config", "mscoree.dll", "helper.exe.local"]) {
    const path = join(dirname(placed.path), sidecar);
    writeFileSync(path, "");
    try {
      const owner = new WindowsBirthInspectionOwner(undefined, { assembly: async () => placed });
      await assert.rejects(prepared(owner), (error: unknown) => messages(error).includes("Unexpected native helper sidecar"), sidecar);
      assert.equal(owner.assembly(), null, sidecar);
      await assert.rejects(provideWindowsBirthHelperAssembly(state, source, sourceSha256), /Unexpected Windows birth helper sidecar/, sidecar);
    } finally { rmSync(path, { force: true }); }
  }
  // With the directory clean again, the same helper prepares.
  assert.deepEqual(await provideWindowsBirthHelperAssembly(state, source, sourceSha256), placed);
});

test("the real owner answers present for this process and closes with a verified retirement", { skip: !windows }, async (t) => {
  const state = stateDirectory(t);
  const owner = new WindowsBirthInspectionOwner(undefined, {
    assembly: (bytes, digest) => provideWindowsBirthHelperAssembly(state, bytes, digest),
  });
  const close = await prepared(owner);
  const placed = owner.assembly();
  assert.ok(placed && placed.sourceSha256 === sourceSha256 && placed.path.endsWith("\\helper.exe"));
  const self = owner.operations().inspectProcessBirth(process.pid, "windows", 2_000);
  assert.equal(self.state, "present");
  await close();
  const receipt = owner.receipt() as { state: string; session: { state: string; helperExit: { code: number } } };
  assert.equal(receipt.state, "CLOSED");
  assert.equal(receipt.session.helperExit.code, 125);
});

// Started as the session starts it: the fixed arguments, no console, System32 and a minimal environment.
function startHelper(path: string, digest: string): ReturnType<typeof spawn> {
  return spawn(path, ["--binary-sha256", digest], {
    windowsHide: true, detached: true, stdio: ["pipe", "pipe", "pipe"], cwd: "C:\\Windows\\System32",
    env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", PATH: "C:\\Windows\\System32", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
  });
}
const exited = (child: ReturnType<typeof spawn>): Promise<number | null> => new Promise((resolve) => child.once("exit", (code) => resolve(code)));

test("the helper refuses a boot line bound to another digest than the one it was started with", { skip: !windows }, async (t) => {
  const state = stateDirectory(t);
  const placed = await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  const child = startHelper(placed.path, placed.sha256);
  let stderr = ""; child.stderr!.on("data", (chunk) => { stderr += chunk; });
  const exit = exited(child);
  const pipeName = `aiboard-birth-${randomBytes(16).toString("hex")}`;
  child.stdin!.end(["BOOT1", "LIVE", randomBytes(32).toString("hex"), randomBytes(32).toString("hex"), pipeName, "2".repeat(64)].join("\t") + "\n");
  assert.equal(await exit, 1);
  // The helper reports a failure as `UNKNOWN:<base64url JSON>`.
  const report = JSON.parse(Buffer.from(stderr.trim().replace(/^UNKNOWN:/, ""), "base64url").toString("utf8"));
  assert.equal(report.class, "System.IO.InvalidDataException");
  assert.equal(report.message, "Bootstrap shape/binary binding.");
});

test("after peer loss the helper waits for its control reader, which retires it with 125", { skip: !windows }, async (t) => {
  const state = stateDirectory(t);
  const placed = await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  const generation = randomBytes(32).toString("hex"), secret = randomBytes(32).toString("hex");
  const pipeName = `aiboard-birth-${randomBytes(16).toString("hex")}`;
  const child = startHelper(placed.path, placed.sha256);
  const exit = exited(child);
  let stdout = "";
  const ready = new Promise<void>((resolve) => child.stdout!.on("data", (chunk) => { stdout += chunk; if (stdout.includes("CTRL_READY|")) resolve(); }));
  child.stdin!.write(["BOOT1", "LIVE", generation, secret, pipeName, placed.sha256].join("\t") + "\n");
  await ready;
  // Connect and leave at once: the helper reads no hello frame, which is peer loss.
  await new Promise<void>((resolve, reject) => {
    const socket = connect(`\\\\.\\pipe\\${pipeName}`, () => { socket.end(); resolve(); });
    socket.once("error", reject);
  });
  const early = await Promise.race([exit, new Promise((resolve) => setTimeout(() => resolve("alive"), 1_500))]);
  assert.equal(early, "alive", "peer loss alone never ends the helper");
  child.stdin!.end(`CLOSE1|${generation}|${secret}\n`);
  assert.equal(await exit, 125);
});
