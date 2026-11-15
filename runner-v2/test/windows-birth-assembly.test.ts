// The Windows birth helper is compiled on the user's machine and hosted in Windows PowerShell; no binary ships.
// These tests drive the real compile, placement, host and owner, and the fail-closed paths around them.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WindowsBirthInspectionOwner } from "../src/windows-birth-inspection.mjs";
import { provideWindowsBirthHelperAssembly } from "../src/windows-job-process-host.js";

const windows = process.platform === "win32";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
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

test("the helper compiles locally, is placed canonically in the state directory, and is reused there", { skip: !windows }, async (t) => {
  const state = stateDirectory(t);
  const first = await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  assert.equal(first.sourceSha256, sourceSha256);
  assert.ok(first.path.startsWith(realpathSync.native(state)), "placed under the backend state directory");
  assert.equal(realpathSync.native(first.path), first.path, "the placed path is already canonical");
  assert.ok(first.path.endsWith("\\BirthHelper.dll"));
  assert.equal(sha(readFileSync(first.path)), first.sha256);
  const again = await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  assert.deepEqual(again, first, "one compile per process and source, one placed file per state directory");
  writeFileSync(first.path, Buffer.from("not the helper"));
  const repaired = await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  assert.equal(sha(readFileSync(repaired.path)), first.sha256, "a changed placed file is replaced by the build's bytes");
  // A second link to the right bytes would be refused by the session on every prepare: placement replaces it.
  const second = join(state, "second-link.dll");
  linkSync(first.path, second);
  assert.equal(statSync(first.path).nlink, 2);
  await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  assert.equal(statSync(first.path).nlink, 1);
  assert.equal(sha(readFileSync(first.path)), first.sha256);
});

test("a source that does not match its pin is never compiled", { skip: !windows }, async (t) => {
  const state = stateDirectory(t);
  await assert.rejects(provideWindowsBirthHelperAssembly(state, source, "0".repeat(64)), /does not match its pin/);
  await assert.rejects(provideWindowsBirthHelperAssembly(state, Buffer.from("class X {}"), sourceSha256), /does not match its pin/);
});

test("preparation fails closed without a matching assembly", { skip: !windows }, async (t) => {
  const state = stateDirectory(t);
  const placed = await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  for (const [name, assembly] of [
    ["missing", async () => undefined],
    ["null", async () => null],
    ["another source", async () => ({ ...placed, sourceSha256: "1".repeat(64) })],
    ["extra fields", async () => ({ ...placed, extra: true })],
  ] as const) {
    const owner = new WindowsBirthInspectionOwner(undefined, { assembly: assembly as never });
    await assert.rejects(prepared(owner), /does not match its pinned source/, name);
    assert.equal(owner.assembly(), null, name);
  }
});

test("an assembly changed after placement is refused before the host starts", { skip: !windows }, async (t) => {
  const state = stateDirectory(t);
  const placed = await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  writeFileSync(placed.path, Buffer.concat([readFileSync(placed.path), Buffer.from([0])]));
  const owner = new WindowsBirthInspectionOwner(undefined, { assembly: async () => placed });
  // Preparation fails on the digest, and its cleanup's own re-check of the assembly fails too.
  await assert.rejects(prepared(owner), (error: unknown) => {
    const messages: string[] = [];
    for (let current = error as { message?: string; cause?: unknown } | undefined; current; current = current.cause as typeof current)
      messages.push(String(current.message));
    return messages.includes("Assembly descriptor digest");
  });
  assert.equal(owner.assembly(), null);
});

test("the real owner answers present for this process and closes with a verified retirement", { skip: !windows }, async (t) => {
  const state = stateDirectory(t);
  const owner = new WindowsBirthInspectionOwner(undefined, {
    assembly: (bytes, digest) => provideWindowsBirthHelperAssembly(state, bytes, digest),
  });
  const close = await prepared(owner);
  const placed = owner.assembly();
  assert.ok(placed && placed.sourceSha256 === sourceSha256);
  const self = owner.operations().inspectProcessBirth(process.pid, "windows", 2_000);
  assert.equal(self.state, "present");
  await close();
  const receipt = owner.receipt() as { state: string; session: { state: string; helperExit: { code: number } } };
  assert.equal(receipt.state, "CLOSED");
  assert.equal(receipt.session.helperExit.code, 125);
});

function startHost(command: string): ReturnType<typeof spawn> {
  return spawn(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", command], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"], cwd: "C:\\Windows\\System32",
    env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", PATH: "C:\\Windows\\System32", PATHEXT: ".COM;.EXE;.BAT;.CMD", PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules" },
  });
}
const exited = (child: ReturnType<typeof spawn>): Promise<number | null> => new Promise((resolve) => child.once("exit", (code) => resolve(code)));

test("the host refuses bytes whose digest differs from the pinned one", { skip: !windows }, async (t) => {
  const { hostCommand } = await import(new URL("../src/windows-birth/session.mjs", import.meta.url).href);
  const state = stateDirectory(t);
  const placed = await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  const child = startHost(hostCommand({ path: placed.path, sha256: "2".repeat(64) }));
  let stderr = ""; child.stderr!.on("data", (chunk) => { stderr += chunk; });
  child.stdin!.end();
  assert.equal(await exited(child), 3);
  assert.match(stderr, /Inspection host assembly digest/);
});

test("after peer loss the host waits for its control reader, which retires it with 125", { skip: !windows }, async (t) => {
  const { hostCommand } = await import(new URL("../src/windows-birth/session.mjs", import.meta.url).href);
  const state = stateDirectory(t);
  const placed = await provideWindowsBirthHelperAssembly(state, source, sourceSha256);
  const generation = randomBytes(32).toString("hex"), secret = randomBytes(32).toString("hex");
  const pipeName = `aiboard-birth-${randomBytes(16).toString("hex")}`;
  const child = startHost(hostCommand(placed));
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
  assert.equal(early, "alive", "peer loss alone never ends the host");
  child.stdin!.end(`CLOSE1|${generation}|${secret}\n`);
  assert.equal(await exit, 125);
});
