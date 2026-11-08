import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { LocalMcpSessions } from "../src/local-stdio-mcp.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";

type Block = { type: string; text?: string; value?: Record<string, unknown> };
type Result = { content: Block[]; isError?: boolean; error?: { code: string; message: string } };
const NOISY = `const lines=[];for(let n=1;n<=20000;n+=1)lines.push(n===13337?"NEEDLE the-token":n===5000?"src/app.ts:12:5 - error TS2322: not assignable":"line "+n+" "+"x".repeat(40));process.stdout.write(lines.join("\\n")+"\\n");`;

/** Lines JSON would escape, on both streams. */
const LOUD = `for(let n=1;n<=2000;n+=1){const line=JSON.stringify({n,level:"info",msg:"a \\"quoted\\" message"})+"\\n";process.stdout.write("o"+line);process.stderr.write("e"+line);}`;
const metadata = (result: Result): Record<string, unknown> => {
  const block = result.content.find((entry) => entry.type === "json"); assert.ok(block?.value, JSON.stringify(result)); return block.value;
};
const text = (result: Result): string => result.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
const node = (script: string) => ({ command: process.execPath, args: [script] });

/** Remote and local MCP clients share this composition; only their transports differ. */
test("a client finds a line in a huge command's output without reading it or running it twice, and pays only for what it can use", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".client-results-"));
  const project = join(root, "project"), state = join(root, "state");
  await mkdir(project); await mkdir(state);
  await writeFile(join(project, "noisy.mjs"), NOISY);
  await writeFile(join(project, "repl.mjs"), `process.stdout.write("ready\\n> ");process.stdin.on("data",(d)=>process.stdout.write("got "+d));setInterval(()=>{},1000);`);
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  const sessions = new LocalMcpSessions({ host, workspacePath: project, statePath: join(state, "owners.sqlite"), permissionProfile: "full", capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
  await sessions.recover();
  const owner = sessions.mint(0), other = sessions.mint(0);
  let key = 0;
  const call = async (name: string, args: Record<string, unknown>, token = owner.token): Promise<Result> =>
    await sessions.perform(token, { operation: "call", name, arguments: { ...args, ...(["process_run", "process_start", "process_interact", "process_signal"].includes(name) ? { idempotencyKey: `key-${++key}` } : {}) } }) as Result;
  try {
    // A plain run gives the real head and tail, the diagnostics between them, and the way to the rest.
    const run = await call("process_run", node("noisy.mjs"));
    assert.equal(run.isError, false, JSON.stringify(run));
    const ran = metadata(run);
    const processId = ran.processId as string;
    assert.match(processId, /^run-/u);
    assert.deepEqual(Object.keys(ran).sort(), ["exitCode", "processId", "stderrBytes", "stdoutBytes"], "nothing a model cannot use");
    assert.equal(ran.exitCode, 0);
    assert.equal(ran.stderrBytes, 0);
    assert.ok((ran.stdoutBytes as number) > 900_000);
    const shown = text(run);
    assert.ok(shown.startsWith("STDOUT\nline 1 "), shown.slice(0, 80));
    assert.match(shown, /^line 20000 x+$/mu, "the tail is the end of the output");
    assert.match(shown, /^L5000: src\/app\.ts:12:5 - error TS2322/mu, "diagnostics carry their true line number");
    const omitted = new RegExp(`lines omitted; find them with process_read_output \\{processId: "${processId}", search: \\{pattern\\}\\} or read them with lines: \\{start, count\\}`, "u");
    assert.match(shown, omitted);
    assert.ok(Buffer.byteLength(shown) < 7 * 1024, String(Buffer.byteLength(shown)));
    assert.equal(run.content.some((block) => block.type === "artifact"), false, "the result fits inline");

    // Searching what was kept finds the line, with its number, in the output of the run already done.
    const searched = await call("process_read_output", { processId, search: { pattern: "^NEEDLE", regex: true, contextLines: 1 } });
    const found = metadata(searched);
    const match = (found.search as { matches: { line: number; byteOffset: number; text: string; before: string[]; after: string[] }[]; exhaustive: boolean });
    assert.equal(match.matches[0]!.line, 13_337);
    assert.equal(match.matches[0]!.text, "NEEDLE the-token");
    assert.match(match.matches[0]!.before[0]!, /^line 13336 /u);
    assert.match(match.matches[0]!.after[0]!, /^line 13338 /u);
    assert.equal(match.exhaustive, true);
    assert.deepEqual(Object.keys(found).sort(), ["complete", "exitCode", "search", "status"]);
    assert.equal(found.status, "stopped");
    assert.equal(found.exitCode, 0);

    // Its byte offset is a place to read from, and the whole output reads as a stopped process's does.
    assert.equal(text(await call("process_read_output", { processId, range: { stream: "stdout", startOffset: match.matches[0]!.byteOffset }, maxBytes: 16 })), "STDOUT\nNEEDLE the-token");
    const paged = await call("process_read_output", { processId, stream: "stdout" });
    const page = metadata(paged);
    assert.ok(text(paged).startsWith("STDOUT\nline 1 "));
    assert.ok(Buffer.byteLength(text(paged)) <= 7 * 1024 + 7);
    const slice = (page.slices as { hasMore: boolean; endOffset: number; totalBytes: number }[])[0]!;
    assert.equal(slice.hasMore, true);
    assert.equal(slice.totalBytes, ran.stdoutBytes);
    const next = await call("process_read_output", { processId, stream: "stdout", cursor: page.cursor });
    assert.ok(text(next).startsWith("STDOUT\n"));
    assert.ok(!text(next).startsWith("STDOUT\nline 1 "), "the cursor moved on");
    assert.equal(metadata(await call("process_read_output", { processId, until: { exit: true }, waitMs: 100, search: { pattern: "absent" } })).complete, true);

    // The number search gave is the number lines reads, over the whole output and not a page of it.
    const byNumber = await call("process_read_output", { processId, stream: "stdout", lines: { start: 13_336, count: 3 } });
    const numbered = metadata(byNumber);
    assert.deepEqual(Object.keys(numbered).sort(), ["exitCode", "slices", "status"], "a stopped process has no cursor to offer");
    assert.deepEqual(numbered.slices, [{ stream: "stdout", startLine: 13_336, totalLines: 20_000, nextLine: 13_339 }]);
    assert.equal(text(byNumber).split("\n")[2], "NEEDLE the-token");
    const last = await call("process_read_output", { processId, stream: "stdout", lines: { start: -1, count: 1 } });
    assert.match(text(last), /^STDOUT\nline 20000 /u);
    assert.equal((metadata(last).slices as { nextLine?: number }[])[0]!.nextLine, undefined);
    assert.equal((await call("process_read_output", { processId, lines: { start: 1, count: 1 }, cursor: page.cursor })).isError, true, "a window and a cursor would disagree about what to read");

    // Search can come with the run itself, and then a clean run prints only the matches.
    const direct = await call("process_run", { ...node("noisy.mjs"), search: { pattern: "needle" } });
    assert.equal(direct.content.length, 1, JSON.stringify(direct.content).slice(0, 300));
    assert.equal((metadata(direct).search as { matches: { line: number }[] }).matches[0]!.line, 13_337);
    assert.match(metadata(direct).processId as string, /^run-/u);
    // A failed one still shows what went wrong, because the matches alone would hide it.
    const failing = await call("process_run", { command: process.execPath, args: ["-e", "console.error('it broke');process.exit(3)"], search: { pattern: "absent" } });
    assert.equal(metadata(failing).exitCode, 3);
    assert.match(text(failing), /STDERR\nit broke/u);
    // A pattern that cannot run is refused before the command does.
    assert.equal((await call("process_run", { command: process.execPath, args: ["-e", "require('fs').writeFileSync('ran.txt','x')"], search: { pattern: "(a+)+$", regex: true } })).isError, true);
    assert.equal((await call("files_list", { path: "." })).content.some((block) => JSON.stringify(block).includes("ran.txt")), false);

    // Small output comes back whole with next to nothing around it.
    const small = await call("process_run", { command: process.execPath, args: ["-e", "console.log('hello')"] });
    assert.deepEqual(metadata(small), { exitCode: 0 });
    assert.equal(text(small).replace(/\r/gu, ""), "STDOUT\nhello\n");
    const raw = await call("process_run", { ...node("noisy.mjs"), render: "raw" });
    assert.ok(Buffer.byteLength(raw.content.map((block) => JSON.stringify(block)).join("")) > 7 * 1024 || raw.content.some((block) => block.type === "artifact"));
    assert.match(metadata(raw).processId as string, /^run-/u, "raw keeps the way to the part it cannot show");

    // The id is its owner's alone, and an id that is gone says what to do.
    const foreign = await call("process_read_output", { processId, search: { pattern: "NEEDLE" } }, other.token);
    assert.equal(foreign.isError, true);
    assert.equal(foreign.error?.code, "process_not_owned");
    const gone = await call("process_read_output", { processId: "run-00000000-0000-4000-8000-000000000000" });
    assert.equal(gone.error?.code, "process_not_found");
    assert.match(text(gone), /no longer retained; run it again/u);
    assert.equal((await call("process_signal", { processId, signal: "SIGTERM" })).isError, true, "a finished command is not a process to signal");

    // A long-running process: start, turn, list and stop say what happened and nothing else.
    const started = await call("process_start", { ...node("repl.mjs"), interactive: true, until: { pattern: "ready" }, waitMs: 20_000 });
    const start = metadata(started);
    assert.deepEqual(Object.keys(start).sort(), ["pid", "processId", "status"], "the identity keeps a block of its own");
    assert.equal(started.content.filter((block) => block.type === "json").length, 2, "and one read, not a snapshot's text as well");
    const firstRead = started.content[1]!.value!.read as Record<string, unknown>;
    assert.equal(firstRead.status, "running");
    assert.deepEqual(firstRead.completion, { source: "pattern", confidence: "certain", matched: "ready" });
    for (const bookkeeping of ["processId", "source", "limits", "exitCode", "signal", "complete", "waited", "slices"]) assert.ok(!(bookkeeping in firstRead), bookkeeping);
    assert.match(text(started), /^STDOUT\nready/u);
    assert.equal(typeof firstRead.cursor, "string", "a running process can still print more");
    const managed = start.processId as string;

    const turned = await call("process_interact", { processId: managed, data: "hi", until: { pattern: "got hi" }, waitMs: 20_000 });
    const turn = metadata(turned);
    assert.deepEqual(turn.write, { status: "acknowledged" });
    assert.ok(!("processId" in turn));
    assert.match(text(turned), /got hi/u);

    const liveLines = await call("process_read_output", { processId: managed, stream: "stdout", lines: { start: 1, count: 1 } });
    assert.equal(text(liveLines), "STDOUT\nready");
    assert.equal(typeof metadata(liveLines).cursor, "string", "a running process can still print more");
    const searchedLive = metadata(await call("process_read_output", { processId: managed, search: { pattern: "ready" } }));
    assert.equal((searchedLive.search as { matches: { line: number }[] }).matches[0]!.line, 1, "a live process is searched as far as its tail reaches");
    assert.equal(typeof searchedLive.cursor, "string");

    const listed = metadata(await call("process_list", {}));
    const row = (listed.processes as Record<string, unknown>[]).find((entry) => entry.processId === managed)!;
    assert.deepEqual(Object.keys(row).sort(), ["lastCompletion", "pid", "processId", "startedAt", "state", "status"]);

    const stopped = await call("process_signal", { processId: managed, signal: "SIGTERM" });
    assert.equal(stopped.content.length, 1);
    assert.equal(metadata(stopped).status, "stopped");
    assert.equal(stopped.content[0]!.type, "json");
    const after = metadata(await call("process_read_output", { processId: managed, search: { pattern: "got hi" } }));
    assert.equal((after.search as { matches: unknown[] }).matches.length, 1, "output stays searchable after the stop");
    assert.equal(after.complete, true);
    assert.ok(!("cursor" in after), "nothing more can come");

    // The listed schemas say the same.
    const { tools } = await sessions.perform(owner.token, { operation: "list" }) as { tools: { name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }[] };
    const tool = (name: string) => tools.find((entry) => entry.name === name)!.inputSchema;
    assert.ok(tool("process_read_output").properties.search);
    assert.ok(tool("process_run").properties.search);
    assert.ok(!tool("files_patch").required!.includes("expectedSha256"), "the hash has a default, so it is not required");
    assert.ok(tool("files_patch").required!.includes("idempotencyKey"));
  } finally {
    owner.revoke(); other.revoke();
    await sessions.close(); await host.close(); await rm(root, { recursive: true, force: true });
  }
});

test("a page of output stays inline whatever it holds, on both streams, and loses nothing", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".client-pages-"));
  const project = join(root, "project"), state = join(root, "state");
  await mkdir(project); await mkdir(state);
  await writeFile(join(project, "loud.mjs"), LOUD);
  await writeFile(join(project, "turns.mjs"), `process.stdout.write("ready\\n");process.stdin.on("data",()=>process.stdout.write("same\\n".repeat(5)+"end\\n"));setInterval(()=>{},1000);`);
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  const sessions = new LocalMcpSessions({ host, workspacePath: project, statePath: join(state, "owners.sqlite"), permissionProfile: "full", capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
  await sessions.recover();
  const owner = sessions.mint(0);
  let key = 0;
  const call = async (name: string, args: Record<string, unknown>): Promise<Result> =>
    await sessions.perform(owner.token, { operation: "call", name, arguments: { ...args, ...(["process_run", "process_start", "process_interact", "process_signal"].includes(name) ? { idempotencyKey: `key-${++key}` } : {}) } }) as Result;
  /** Nothing was cut into a preview, and no block is over the broker's bound. */
  const inline = (result: Result) => {
    assert.equal(result.content.some((block) => block.type === "artifact"), false, JSON.stringify(result.content).slice(0, 200));
    for (const block of result.content) assert.ok(Buffer.byteLength(block.text ?? JSON.stringify(block.value)) <= 8 * 1024);
    assert.doesNotMatch(text(result), /bytes omitted|stored as an artifact/u);
  };
  const line = (prefix: string, n: number) => prefix + JSON.stringify({ n, level: "info", msg: 'a "quoted" message' }) + "\n";
  const expected = (prefix: string) => Array.from({ length: 2000 }, (_, n) => line(prefix, n + 1)).join("");
  try {
    const run = await call("process_run", node("loud.mjs"));
    const processId = metadata(run).processId as string;
    assert.match(processId, /^run-/u);
    inline(run);

    // Following the cursor brings back every byte of both streams, a bounded page at a time.
    let cursor: string | undefined, out = "", err = "", pages = 0;
    for (; pages < 100; pages += 1) {
      const page = await call("process_read_output", { processId, ...(cursor ? { cursor } : {}) });
      inline(page);
      for (const block of page.content) if (block.type === "text") { if (block.text!.startsWith("STDOUT\n")) out += block.text!.slice(7); else err += block.text!.slice(7); }
      if (metadata(page).complete) break;
      cursor = metadata(page).cursor as string;
    }
    assert.ok(pages >= 2);
    assert.equal(out, expected("o"));
    assert.equal(err, expected("e"));

    // Asking for more than a page gets a page and the way on, not a preview with its middle gone.
    const large = await call("process_read_output", { processId, stream: "stdout", maxBytes: 1_000_000 });
    inline(large);
    assert.ok(text(large).startsWith("STDOUT\no{"));
    assert.equal((metadata(large).slices as { hasMore: boolean }[])[0]!.hasMore, true);
    assert.equal(typeof metadata(large).cursor, "string");
    const tail = await call("process_read_output", { processId, stream: "stdout", tailBytes: 1_000_000 });
    inline(tail);
    assert.ok(text(tail).endsWith(line("o", 2000)), "a tail read reaches the end of the output");
    const all = expected("o"), [tailed] = metadata(tail).slices as { startOffset: number }[];
    assert.deepEqual(metadata(tail).slices, [{ stream: "stdout", startOffset: all.length - 7 * 1024, totalBytes: all.length }], "and says where it starts");
    assert.equal(text(await call("process_read_output", { processId, range: { stream: "stdout", startOffset: tailed!.startOffset - 16 }, maxBytes: 16 })),
      `STDOUT\n${all.slice(tailed!.startOffset - 16, tailed!.startOffset)}`, "so range reads what comes before it");

    // Lines of both streams, each in its own block, and nextLine goes on from there.
    const both = await call("process_read_output", { processId, lines: { start: 1, count: 2000 } });
    inline(both);
    assert.equal(both.content.filter((block) => block.type === "text").length, 2);
    const windows = metadata(both).slices as { stream: string; startLine: number; totalLines: number; nextLine: number }[];
    assert.deepEqual(windows.map((window) => [window.stream, window.startLine, window.totalLines]), [["stdout", 1, 2000], ["stderr", 1, 2000]]);
    const shown = both.content.find((block) => block.type === "text")!.text!.split("\n").length - 1;
    assert.equal(windows[0]!.nextLine, shown + 1);
    assert.equal(text(await call("process_read_output", { processId, stream: "stdout", lines: { start: windows[0]!.nextLine, count: 1 } })), `STDOUT\n${line("o", shown + 1).trimEnd()}`);

    // A start that waits has all of that and its identity too.
    const started = await call("process_start", { ...node("loud.mjs"), until: { exit: true }, waitMs: 20_000 });
    inline(started);
    assert.equal(started.isError, false, JSON.stringify(started).slice(0, 300));
    assert.equal(typeof metadata(started).processId, "string", "the identity survives however much the process printed");
    assert.equal(started.content.filter((block) => block.type === "text").length, 2);

    // A turn's lines keep their numbers: nothing is folded for them, however alike they are.
    const turns = metadata(await call("process_start", { ...node("turns.mjs"), interactive: true, until: { pattern: "ready" }, waitMs: 20_000 })).processId as string;
    const turn = await call("process_interact", { processId: turns, data: "go", until: { pattern: "end" }, waitMs: 20_000, lines: { start: 1, count: 10 } });
    assert.equal(turn.isError, false, JSON.stringify(turn).slice(0, 300));
    assert.equal(text(turn), "STDOUT\nsame\nsame\nsame\nsame\nsame\nend");
    assert.equal(((metadata(turn).read as { slices: { totalLines: number }[] }).slices)[0]!.totalLines, 6);
    assert.equal(metadata(await call("process_signal", { processId: turns, signal: "SIGTERM" })).status, "stopped");

    // Output that is not UTF-8 grows when it is decoded. It is split, not cut, so nothing is lost and the cursor stays honest.
    const binary = await call("process_run", { command: process.execPath, args: ["-e", "process.stdout.write(Buffer.alloc(30000, 0xe9))"] });
    inline(binary);
    const binaryPage = await call("process_read_output", { processId: metadata(binary).processId as string, stream: "stdout" });
    inline(binaryPage);
    const decoded = binaryPage.content.filter((block) => block.type === "text");
    assert.ok(decoded.length >= 3, String(decoded.length));
    assert.equal(decoded.map((block) => block.text).join("").replace("STDOUT\n", ""), "\ufffd".repeat((metadata(binaryPage).slices as { endOffset: number }[])[0]!.endOffset));

    // A search that stopped early on a stopped process offers no cursor: nothing a cursor reads would finish it.
    const stopped = await call("process_read_output", { processId, search: { pattern: "info", maxMatches: 2 } });
    assert.equal((metadata(stopped).search as { truncated: string }).truncated, "max_matches");
    assert.ok(!("cursor" in metadata(stopped)));
  } finally {
    owner.revoke();
    await sessions.close(); await host.close(); await rm(root, { recursive: true, force: true });
  }
});
