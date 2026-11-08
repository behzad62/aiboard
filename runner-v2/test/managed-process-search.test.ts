import assert from "node:assert/strict";
import test from "node:test";

import { ManagedProcessError, type ManagedOutputStreamEvidence } from "../src/managed-process-contracts.js";
import { readOutputLines, retainedRegions, searchOutput, validateOutputSearch, type ManagedOutputSearchRequest } from "../src/managed-process-search.js";
import { renderPlainLines, summarizeOutput } from "../src/managed-process-wait.js";
import { clientStreamText } from "../src/process-tools.js";

function stream(text: string | Buffer, options: { name?: "stdout" | "stderr"; tailBytes?: number; spill?: boolean } = {}): { value: ManagedOutputStreamEvidence; readSpill: (id: string) => Promise<Uint8Array> } {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const tail = new Uint8Array(bytes.subarray(Math.max(0, bytes.length - (options.tailBytes ?? bytes.length))));
  const spill = options.spill ? { artifactId: "a".repeat(64), bytes: bytes.length } : undefined;
  return { value: { stream: options.name ?? "stdout", totalBytes: bytes.length, tail, lossyBytes: 0, lossReasons: [], ...(spill ? { spill } : {}) }, readSpill: async () => bytes };
}

const search = (text: string | Buffer, request: ManagedOutputSearchRequest, options: Parameters<typeof stream>[1] = {}) => {
  const { value, readSpill } = stream(text, options);
  return searchOutput({ streams: [value], request, readSpill });
};

test("finds the one line in a noisy command's output, with its 1-based number and the offset it starts at", async () => {
  const lines = Array.from({ length: 20_000 }, (_, n) => n + 1 === 13_337 ? "NEEDLE token-abc" : `line ${n + 1} ${"x".repeat(40)}`);
  const output = lines.join("\n") + "\n";
  const found = await search(output, { pattern: "needle" }, { tailBytes: 128 * 1024, spill: true });
  assert.deepEqual(found, { matches: [{ stream: "stdout", line: 13_337, byteOffset: Buffer.byteLength(lines.slice(0, 13_336).join("\n") + "\n"), text: "NEEDLE token-abc" }], exhaustive: true });
  assert.equal(output.slice(found.matches[0]!.byteOffset, found.matches[0]!.byteOffset + 6), "NEEDLE");
});

test("a line's number survives chunk boundaries and non-ASCII text before it", async () => {
  // Far past one 1 MiB chunk, with multi-byte characters so bytes and characters disagree.
  const count = 120_000;
  const lines = Array.from({ length: count }, (_, n) => `日本語 ${n + 1} ${"é".repeat(8)}`);
  lines[count - 2] = "the target";
  const output = lines.join("\n");
  assert.ok(Buffer.byteLength(output) > 3 * 1024 * 1024);
  const [match] = (await search(output, { pattern: "the target" }, { tailBytes: 1024, spill: true })).matches;
  assert.equal(match!.line, count - 1);
  assert.equal(Buffer.from(output).subarray(match!.byteOffset).toString("utf8").split("\n")[0], "the target");
});

test("a pattern matches the line a terminal would show, while the numbers stay those of the raw output", async () => {
  const output = "\x1b[32mfirst\x1b[0m\r\nprogress 10%\rprogress 100%\r\n\x1b]0;title\x07NEEDLE here\n\x1b]0;open title\nlast\n";
  assert.deepEqual((await search(output, { pattern: "^progress 100%$", regex: true })).matches.map((match) => [match.line, match.text]), [[2, "progress 100%"]]);
  assert.deepEqual((await search(output, { pattern: "^NEEDLE", regex: true })).matches.map((match) => [match.line, match.text]), [[3, "NEEDLE here"]]);
  assert.deepEqual((await search(output, { pattern: "last" })).matches.map((match) => match.line), [5]);
  assert.equal(renderPlainLines(output).split("\n").length, output.split("\n").length, "rendering keeps every line");
  assert.deepEqual((await search(output, { pattern: "^progress 10%", regex: true })).matches, [], "overwritten progress is not on screen");
});

test("literal text needs no escaping, and case follows fs.search", async () => {
  const output = "a.b (c)\nAXB\nvalue [1] {x} ^$ | * + ? \\ /path\na-b\n";
  assert.deepEqual((await search(output, { pattern: "a.b" })).matches.map((match) => match.line), [1]);
  assert.deepEqual((await search(output, { pattern: "a.b", regex: true })).matches.map((match) => match.line), [1, 2, 4]);
  assert.deepEqual((await search(output, { pattern: "a.b", regex: true, caseSensitive: true })).matches.map((match) => match.line), [1, 4]);
  for (const literal of ["(c)", "[1]", "{x}", "^$", "|", "* +", "? \\ /path", "a-b"]) {
    assert.equal((await search(output, { pattern: literal })).matches.length, 1, literal);
  }
});

test("a line matches once, and an empty match never invents a line", async () => {
  const output = "x x x\n\ny\n";
  assert.deepEqual((await search(output, { pattern: "x" })).matches.map((match) => match.line), [1]);
  assert.deepEqual((await search(output, { pattern: "^", regex: true })).matches.map((match) => match.line), [1, 2, 3]);
  assert.deepEqual((await search(output, { pattern: "^$", regex: true })).matches.map((match) => match.line), [2]);
});

test("a pattern sees one line at a time, so whitespace cannot carry a match to another line", async () => {
  const lines = async (output: string, pattern: string) => (await search(output, { pattern, regex: true })).matches.map((match) => match.line);
  assert.deepEqual(await lines("error\nerror\nerror\nerror\n", "error\\s*"), [1, 2, 3, 4]);
  assert.deepEqual(await lines("\n\n\n", "^\\s*$"), [1, 2, 3]);
  assert.deepEqual(await lines("foo\nerror\n", "\\s*error"), [2], "it cannot start on the line above");
  assert.deepEqual(await lines("foo\nbar\n", "foo\\sbar"), [], "or end on the line below");
  assert.deepEqual(await lines("an error here\n", "error[^\\n]*"), [1], "a class that leaves out a newline is still a pattern for one line");
  // Over a million blank lines, whitespace is not quadratic any more, so it stays inside the bound.
  assert.deepEqual(await lines("\n".repeat(1024 * 1024), "\\s*error"), []);
});

test("a line too long for one chunk is searched in pieces, and the answer says so", async () => {
  const mib = 1024 * 1024;
  const across = await search(`${"a".repeat(mib - 3)}NEEDLE${"b".repeat(100)}\n`, { pattern: "NEEDLE" });
  assert.deepEqual(across.matches, []);
  assert.equal(across.exhaustive, false, "a match across two pieces could be missed, so no match proves nothing");
  assert.equal(across.splitLines, true);
  assert.deepEqual((await search(`${"a".repeat(mib)}START\n`, { pattern: "^START", regex: true })).matches, [], "^ means the start of a line, not of a piece of one");
  assert.deepEqual((await search(`${"a".repeat(mib - 3)}END${"b".repeat(100)}\n`, { pattern: "END$", regex: true })).matches, [], "and $ the end of one");
  const second = await search(`first\n${"a".repeat(mib + 10)}NEEDLE\n`, { pattern: "NEEDLE", contextLines: 1 });
  assert.equal(second.matches[0]!.byteOffset, 6, "a match in a later piece names where its line starts");
  assert.deepEqual(second.matches[0]!.before, ["first"], "and its context is other lines, not the same one");
  const twice = `${"NEEDLE".padEnd(mib + 100, "a")}NEEDLE\n`;
  assert.deepEqual((await search(twice, { pattern: "NEEDLE" })).matches.map((match) => match.line), [1], "a line matches once, however many pieces it takes");
  assert.equal((await search(twice, { pattern: "NEEDLE", maxMatches: 1 })).truncated, undefined, "and its second piece is not a second match");
  assert.equal((await search(`${twice}NEEDLE\n`, { pattern: "NEEDLE", maxMatches: 1 })).truncated, "max_matches", "while a match on the next line still counts");
  const inside = await search(`${"a".repeat(mib + 10)}NEEDLE\nnext NEEDLE\n`, { pattern: "needle" });
  assert.deepEqual(inside.matches.map((match) => [match.line, match.text]), [[1, "aaaaaaaaaaNEEDLE"], [2, "next NEEDLE"]], "numbers hold across the pieces");
  assert.equal((await search("short\n", { pattern: "short" })).splitLines, undefined);
});

test("one match with wide context stays inline, with as much of its context as fits", async () => {
  const wide = "語".repeat(300);
  const found = await search(Array.from({ length: 11 }, (_, n) => n === 5 ? `NEEDLE ${wide}` : wide).join("\n") + "\n", { pattern: "NEEDLE", contextLines: 5 });
  assert.equal(found.matches.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(found)) < 8 * 1024, String(Buffer.byteLength(JSON.stringify(found))));
  assert.equal(found.matches[0]!.before!.length, found.matches[0]!.after!.length);
  assert.ok(found.matches[0]!.before!.length >= 1 && found.matches[0]!.before!.length < 5);
  const narrow = await search("before\nNEEDLE\nafter\n", { pattern: "NEEDLE", contextLines: 5 });
  assert.deepEqual([narrow.matches[0]!.before, narrow.matches[0]!.after], [["before"], ["after"]], "context that fits is left alone");
});

test("a huge line renders only as much of itself as can be shown", async () => {
  const huge = `${"\x1b[0m".repeat(20_000)}late text\n`;
  assert.deepEqual((await readOutputLines({ streams: [stream(huge).value], start: 1, count: 1 }))[0]!.lines, ["…"], "what lies past the bound is not rendered, and the mark says there is more");
  assert.deepEqual((await search(`NEEDLE\n${huge}`, { pattern: "NEEDLE", contextLines: 1 })).matches[0]!.after, ["…"]);
  // A progress line shows its last state, however far along the line that is.
  const progress = `${"downloading 50%\r".repeat(5_000)}DONE all files\r\n`;
  assert.deepEqual((await readOutputLines({ streams: [stream(progress).value], start: 1, count: 1 }))[0]!.lines, ["DONE all files"]);
  assert.deepEqual((await search(`NEEDLE\n${progress}`, { pattern: "NEEDLE", contextLines: 1 })).matches[0]!.after, ["DONE all files"]);
  const plain = `${"\x1b[31m".repeat(10)}${"z".repeat(1990)}\n`;
  assert.equal((await readOutputLines({ streams: [stream(plain).value], start: 1, count: 1 }))[0]!.lines[0], "z".repeat(1990), "a line within the bound is whole");
});

test("context lines come from either side of a chunk boundary and stop at the ends", async () => {
  const lines = Array.from({ length: 80_000 }, (_, n) => `row ${n + 1} ${"z".repeat(12)}`);
  const output = lines.join("\n") + "\n";
  // The first chunk ends a little after 1 MiB, so this line sits at the boundary whichever way it falls.
  const boundary = Buffer.from(output).subarray(0, 1024 * 1024).toString("utf8").split("\n").length - 1;
  lines[boundary - 1] = "NEEDLE";
  const [match] = (await search(lines.join("\n") + "\n", { pattern: "needle", contextLines: 2 })).matches;
  assert.equal(match!.line, boundary);
  assert.deepEqual(match!.before, [lines[boundary - 3], lines[boundary - 2]]);
  assert.deepEqual(match!.after, [lines[boundary], lines[boundary + 1]]);
  const [first] = (await search("one\r\ntwo\r\nthree\r\n", { pattern: "one", contextLines: 5 })).matches;
  assert.equal(first!.before, undefined);
  assert.deepEqual(first!.after, ["two", "three"]);
  const [last] = (await search("one\r\ntwo\r\nthree", { pattern: "three", contextLines: 1 })).matches;
  assert.deepEqual(last!.before, ["two"]);
  assert.equal(last!.after, undefined);
});

test("a match far along a long line stays in view", async () => {
  const output = `${"a".repeat(50_000)}NEEDLE${"b".repeat(50_000)}\n`;
  const [match] = (await search(output, { pattern: "NEEDLE" })).matches;
  assert.match(match!.text, /^…a+NEEDLEb+…$/u);
  assert.ok(match!.text.length <= 302);
  const short = (await search("short NEEDLE\n", { pattern: "NEEDLE" })).matches[0]!;
  assert.equal(short.text, "short NEEDLE");
});

test("truncation is honest: it says why, and only when something was really left", async () => {
  const output = Array.from({ length: 50 }, (_, n) => `hit ${n + 1}`).join("\n") + "\n";
  const first = await search(output, { pattern: "hit", maxMatches: 3 });
  assert.deepEqual(first.matches.map((match) => match.line), [1, 2, 3]);
  assert.equal(first.truncated, "max_matches");
  assert.equal(first.exhaustive, false);
  const exact = await search(output, { pattern: "hit", maxMatches: 50 });
  assert.equal(exact.matches.length, 50);
  assert.equal(exact.truncated, undefined, "exactly the last match is not a truncation");
  assert.equal(exact.exhaustive, true);
  const none = await search(output, { pattern: "absent" });
  assert.deepEqual(none, { matches: [], exhaustive: true });
  const wide = await search(Array.from({ length: 100 }, (_, n) => `hit ${n} ${"w".repeat(280)}`).join("\n"), { pattern: "hit", maxMatches: 100, contextLines: 5 });
  assert.equal(wide.truncated, "size_limit");
  assert.ok(wide.matches.length >= 1);
  assert.ok(Buffer.byteLength(JSON.stringify(wide)) < 8 * 1024, "a result stays inline");
});

test("the search stops at its time budget and says so, and an empty answer there is not a clean one", async () => {
  const { value, readSpill } = stream(Array.from({ length: 200_000 }, (_, n) => `line ${n} ${"q".repeat(20)}`).join("\n"), { tailBytes: 1024, spill: true });
  let time = 0;
  // Past the budget after the first chunk's check.
  const result = await searchOutput({ streams: [value], request: { pattern: "absent" }, readSpill, now: () => { const at = time; time += 6_000; return at; } });
  assert.equal(result.truncated, "time_limit");
  assert.equal(result.exhaustive, false);
  assert.deepEqual(result.matches, []);
});

test("bytes retention lost are named as not searched, never as no match", async () => {
  const before = "lost NEEDLE\n".repeat(10);
  const output = Buffer.from(before + "kept tail\n");
  // Tail only, as a live process has: the earlier bytes are out of reach.
  const live = await search(output, { pattern: "NEEDLE" }, { tailBytes: 10 });
  assert.deepEqual(live, { matches: [], exhaustive: false, notSearched: [{ stream: "stdout", fromOffset: 0, toOffset: before.length }] });
  // A spill that ended before the tail began: the bytes between them are gone, and later lines have no number.
  const value: ManagedOutputStreamEvidence = { stream: "stderr", totalBytes: 1000, tail: new Uint8Array(Buffer.from("tail NEEDLE\n")), lossyBytes: 500, lossReasons: ["spill_cap_exceeded"], spill: { artifactId: "b".repeat(64), bytes: 12 } };
  const gapped = await searchOutput({ streams: [value], request: { pattern: "NEEDLE" }, readSpill: async () => Buffer.from("head NEEDLE\n") });
  assert.deepEqual(gapped.matches.map((match) => [match.stream, match.line, match.byteOffset]), [["stderr", 1, 0], ["stderr", undefined, 988]]);
  assert.deepEqual(gapped.notSearched, [{ stream: "stderr", fromOffset: 12, toOffset: 988 }]);
  assert.equal(gapped.exhaustive, false);
});

test("a region cut mid-character starts at the next whole one", async () => {
  const bytes = Buffer.from("日本語 NEEDLE\n");
  const value: ManagedOutputStreamEvidence = { stream: "stdout", totalBytes: 100, tail: new Uint8Array(bytes.subarray(1)), lossyBytes: 0, lossReasons: [] };
  const [match] = (await searchOutput({ streams: [value], request: { pattern: "NEEDLE" } })).matches;
  assert.equal(match!.text, "本語 NEEDLE");
});

test("both streams are searched, each with its own numbering", async () => {
  const stdout = stream("one\nNEEDLE out\n").value, stderr = stream("NEEDLE err\n", { name: "stderr" }).value;
  const result = await searchOutput({ streams: [stdout, stderr], request: { pattern: "needle" } });
  assert.deepEqual(result.matches.map((match) => [match.stream, match.line]), [["stdout", 2], ["stderr", 1]]);
});

test("a spill is read only when the tail does not already hold everything, and a short one is refused", async () => {
  let reads = 0;
  const value: ManagedOutputStreamEvidence = { stream: "stdout", totalBytes: 3, tail: new Uint8Array(Buffer.from("abc")), lossyBytes: 0, lossReasons: [], spill: { artifactId: "c".repeat(64), bytes: 3 } };
  assert.deepEqual((await retainedRegions(value, async () => { reads += 1; return Buffer.from("abc"); })).map((region) => region.fromOffset), [0]);
  assert.equal(reads, 0);
  // The tail goes past the end of the spill: the two join into one region without repeating a byte.
  const joined = await retainedRegions({ ...value, totalBytes: 5, tail: new Uint8Array(Buffer.from("cde")), spill: { artifactId: "c".repeat(64), bytes: 3 } }, async () => Buffer.from("abc"));
  assert.equal(Buffer.from(joined[0]!.bytes).toString(), "abcde");
  await assert.rejects(retainedRegions({ ...value, totalBytes: 9, spill: { artifactId: "c".repeat(64), bytes: 6 } }, async () => Buffer.from("abc")), /shorter than its recorded length/u);
});

test("an unsafe or malformed request is refused before any output is touched", () => {
  const refused = (value: unknown, message: RegExp) => assert.throws(() => validateOutputSearch(value), (error: unknown) => error instanceof ManagedProcessError && error.code === "invalid_arguments" && message.test(error.message));
  refused(undefined, /must be an object/u);
  refused([], /must be an object/u);
  refused({}, /non-empty string/u);
  refused({ pattern: "" }, /non-empty string/u);
  refused({ pattern: "x".repeat(257) }, /exceeds 256/u);
  refused({ pattern: "x", extra: 1 }, /search\.extra is not allowed/u);
  refused({ pattern: "x", regex: "yes" }, /regex must be a boolean/u);
  refused({ pattern: "x", contextLines: 6 }, /contextLines must be an integer 0\.\.5/u);
  refused({ pattern: "x", maxMatches: 0 }, /maxMatches must be an integer 1\.\.200/u);
  refused({ pattern: "(a+)+$", regex: true }, /nested quantifiers/u);
  refused({ pattern: "(a)\\1", regex: true }, /backreferences/u);
  refused({ pattern: "(", regex: true }, /does not compile/u);
  // A pattern sees one line at a time, so one that asks for a newline could never match.
  refused({ pattern: "a\nb" }, /one line at a time/u);
  refused({ pattern: "a\\nb", regex: true }, /one line at a time/u);
  refused({ pattern: "a\\\\\\nb", regex: true }, /one line at a time/u);
  refused({ pattern: "[a]\\n", regex: true }, /one line at a time/u);
  assert.deepEqual(validateOutputSearch({ pattern: "C:\\\\new", regex: true }), { pattern: "C:\\\\new", regex: true }, "an escaped backslash before an n is not a newline");
  assert.deepEqual(validateOutputSearch({ pattern: "error[^\\n]*", regex: true }), { pattern: "error[^\\n]*", regex: true }, "nor is one in a class");
  assert.deepEqual(validateOutputSearch({ pattern: "a\\nb" }), { pattern: "a\\nb" }, "and as literal text it is a backslash and an n");
  // The same text is fine as a literal, which cannot backtrack.
  assert.deepEqual(validateOutputSearch({ pattern: "(a+)+$" }), { pattern: "(a+)+$" });
});

test("a pattern that passes the screen but runs away is stopped, not left to stall the Runner", async () => {
  const output = `${"a".repeat(200_000)}!\n`;
  await assert.rejects(search(output, { pattern: "a*a*a*a*a*a*b", regex: true }), (error: unknown) =>
    error instanceof ManagedProcessError && error.code === "invalid_arguments" && /exceeded its 250 ms bound/u.test(error.message));
  assert.equal((await search("still works\n", { pattern: "works" })).matches.length, 1, "the shared evaluator is usable afterwards");
});

test("lines are read by the same 1-based numbers search reports, from the whole output", async () => {
  const lines = Array.from({ length: 20_000 }, (_, n) => n + 1 === 13_337 ? "NEEDLE" : `line ${n + 1}`);
  const { value, readSpill } = stream(lines.join("\n") + "\n", { tailBytes: 128, spill: true });
  const read = (start: number, count: number) => readOutputLines({ streams: [value], start, count, readSpill });

  const [middle] = await read(13_336, 3);
  assert.deepEqual(middle, { stream: "stdout", lines: ["line 13336", "NEEDLE", "line 13338"], startLine: 13_336, totalLines: 20_000, nextLine: 13_339 });
  const line = (await searchOutput({ streams: [value], request: { pattern: "NEEDLE" }, readSpill })).matches[0]!.line!;
  assert.deepEqual((await read(line, 1))[0]!.lines, ["NEEDLE"], "a match's number is where lines finds it");

  // Negative counts from the end of the output, not of some page, and the last line has no next.
  assert.deepEqual(await read(-2, 5), [{ stream: "stdout", lines: ["line 19999", "line 20000"], startLine: 19_999, totalLines: 20_000 }]);
  assert.equal((await read(-100_000, 1))[0]!.startLine, 1, "far past the start stops at the first line");
  assert.deepEqual((await read(1, 1))[0]!.lines, ["line 1"]);
  assert.deepEqual((await read(0, 1))[0]!.lines, ["line 1"], "0 is not a line, so it reads as the first");
  assert.deepEqual(await read(30_000, 5), [{ stream: "stdout", lines: [], startLine: 30_000, totalLines: 20_000 }], "past the end says how many there are");

  // A page stays inline; nextLine continues it without losing a line.
  const page = (await read(1, 2000))[0]!;
  assert.ok(Buffer.byteLength(page.lines.join("\n")) <= 6 * 1024);
  assert.equal(page.nextLine, page.startLine + page.lines.length);
  assert.deepEqual((await read(page.nextLine!, 1))[0]!.lines, [lines[page.nextLine! - 1]]);
});

test("reading lines handles output with no final newline, terminal control, and nothing at all", async () => {
  const read = async (text: string, start = 1) => (await readOutputLines({ streams: [stream(text).value], start, count: 10 }))[0];
  assert.deepEqual((await read("one\ntwo"))!.lines, ["one", "two"]);
  assert.equal((await read("one\ntwo"))!.totalLines, 2);
  assert.equal((await read("one\ntwo\n"))!.totalLines, 2, "a final newline does not start a line");
  assert.deepEqual((await read("\x1b[31mred\x1b[0m\r\nbar 10%\rbar 100%\r\n"))!.lines, ["red", "bar 100%"]);
  assert.deepEqual((await read("\n\n"))!.lines, ["", ""]);
  assert.equal(await read(""), undefined, "a stream that printed nothing has no window");
  assert.ok((await read("z".repeat(5000)))!.lines[0]!.length <= 2001, "one enormous line is clipped");
});

test("reading lines says when numbers count from what is kept, and reads the end across a gap", async () => {
  const bytes = Buffer.from("日本語 first\nsecond\nthird\n");
  const live: ManagedOutputStreamEvidence = { stream: "stdout", totalBytes: 1000 + bytes.length, tail: new Uint8Array(bytes.subarray(1)), lossyBytes: 0, lossReasons: [] };
  const [tail] = await readOutputLines({ streams: [live], start: 2, count: 1 });
  assert.deepEqual(tail, { stream: "stdout", lines: ["second"], startLine: 2, totalLines: 3, nextLine: 3, linesRelativeToByteOffset: 1001 });
  assert.deepEqual((await readOutputLines({ streams: [live], start: 1, count: 1 }))[0]!.lines, ["本語 first"], "a cut character is skipped");

  const gapped: ManagedOutputStreamEvidence = { stream: "stdout", totalBytes: 1000, tail: new Uint8Array(Buffer.from("end one\nend two\n")), lossyBytes: 500, lossReasons: ["spill_cap_exceeded"], spill: { artifactId: "d".repeat(64), bytes: 11 } };
  const readSpill = async () => Buffer.from("head\nhead 2\n");
  assert.deepEqual((await readOutputLines({ streams: [gapped], start: 1, count: 2, readSpill }))[0], { stream: "stdout", lines: ["head", "head 2"], startLine: 1, totalLines: 2, gap: { fromOffset: 11, toOffset: 984 } }, "reading forward says where it stops and what was lost");
  assert.equal((await readOutputLines({ streams: [gapped], start: 1, count: 1, readSpill }))[0]!.gap, undefined, "not before it gets there");
  const end = (await readOutputLines({ streams: [gapped], start: -1, count: 1, readSpill }))[0]!;
  assert.deepEqual(end.lines, ["end two"]);
  assert.equal(end.linesRelativeToByteOffset, 984);
  // A positive number would land back before the gap, so the next page past one is asked for from the end.
  const earlier = (await readOutputLines({ streams: [gapped], start: -2, count: 1, readSpill }))[0]!;
  assert.deepEqual(earlier.lines, ["end one"]);
  assert.equal(earlier.nextLine, -1);
  assert.deepEqual((await readOutputLines({ streams: [gapped], start: earlier.nextLine!, count: 1, readSpill }))[0]!.lines, ["end two"]);
});

test("a client summary names the way to the rest, stays bounded, and numbers lines from one", () => {
  const lines = Array.from({ length: 5000 }, (_, n) => `line ${n + 1} ${"x".repeat(30)}`);
  lines[2500] = "src/app.ts:12:5 - error TS2322: not assignable";
  const summary = summarizeOutput(lines.join("\n") + "\n", { maxBytes: 6 * 1024, headLines: 20, tailLines: 40, firstLine: 1, omittedHint: 'search or read them with process_read_output {processId: "run-1"}' });
  const text = summary.text.split("\n");
  assert.equal(text[0], lines[0]);
  assert.equal(text[20], '… (4940 lines omitted; search or read them with process_read_output {processId: "run-1"}) …');
  assert.equal(text[22], `L2501: ${lines[2500]}`);
  assert.equal(text.at(-2), lines[4999]);
  assert.ok(Buffer.byteLength(summary.text) <= 6 * 1024);

  // Wide lines use up the budget before the line counts do; the omitted count stays true.
  const wide = Array.from({ length: 2000 }, (_, n) => `${n + 1} ${"w".repeat(290)}`);
  const bounded = summarizeOutput(wide.join("\n"), { maxBytes: 6 * 1024, headLines: 20, tailLines: 40, firstLine: 1, omittedHint: "read" });
  assert.ok(Buffer.byteLength(bounded.text) <= 6 * 1024, String(Buffer.byteLength(bounded.text)));
  const shown = bounded.text.split("\n");
  const omitted = Number(/\((\d+) lines omitted/u.exec(bounded.text)![1]);
  assert.equal(shown.length - 1 + omitted, 2000);

  // One enormous line is clipped, and that is said too.
  const single = summarizeOutput("y".repeat(100_000), { maxBytes: 6 * 1024, omittedHint: "read it" });
  assert.equal(single.summarized, true);
  assert.ok(single.text.endsWith("… (long lines clipped; read it) …"));

  // Repeats inside the head or tail are folded, even though the numbering counts every line.
  const repeats = summarizeOutput(`${"same\n".repeat(30)}${"other line\n".repeat(3000)}`, { maxBytes: 6 * 1024, headLines: 20, tailLines: 40, omittedHint: "read" });
  assert.match(repeats.text, /^same\n… \(19 more identical lines\)\n… \(2970 lines omitted; read\) …\nother line\n… \(39 more identical lines\)\n$/u);

  // Lines that differ only past the clip are not identical, and Build's summary folds nothing of its own.
  const similar = Array.from({ length: 40 }, (_, n) => `${"p".repeat(400)} ${n}`).join("\n") + "\n";
  assert.doesNotMatch(summarizeOutput(similar, { maxBytes: 6 * 1024, headLines: 20, tailLines: 40, omittedHint: "read" }).text, /identical/u);
  assert.doesNotMatch(summarizeOutput(similar).text, /identical/u);
  assert.doesNotMatch(summarizeOutput("same line\n".repeat(3000)).text, /identical/u);

  // A line whose number nobody knows carries none.
  const unnumbered = summarizeOutput(lines.join("\n") + "\n", { maxBytes: 6 * 1024, headLines: 20, tailLines: 40, firstLine: null, omittedHint: "read" });
  assert.ok(unnumbered.text.split("\n").includes(lines[2500]!));
  assert.doesNotMatch(unnumbered.text, /^L\d+:/mu);

  // Under the limit nothing changes.
  assert.deepEqual(summarizeOutput("ok\n", { maxBytes: 6 * 1024, omittedHint: "read" }), { text: "ok\n", summarized: false, totalLines: 1, errorLines: [] });
});

test("past what a summary reads whole, its numbers are still the ones search and lines use", async () => {
  const lines = Array.from({ length: 600_000 }, (_, n) => n === 598_000 ? "src/app.ts:1:1 - error TS1: boom" : `line ${n + 1} ${"x".repeat(24)}`);
  const output = Buffer.from(lines.join("\n") + "\n");
  assert.ok(output.byteLength > 16 * 1024 * 1024);
  const { value, readSpill } = stream(output, { tailBytes: 128 * 1024, spill: true });
  const text = await clientStreamText(value, "summary", "run-1", { readArtifact: readSpill });
  assert.match(text, /^L598001: src\/app\.ts:1:1 - error TS1: boom$/mu);
  assert.match(text, /^… \(first \d+ bytes not shown\) …\n/u);
  assert.deepEqual((await readOutputLines({ streams: [value], start: 598_001, count: 1, readSpill }))[0]!.lines, [lines[598_000]], "the number it printed is the number lines reads");
  assert.equal((await searchOutput({ streams: [value], request: { pattern: "TS1: boom" }, readSpill })).matches[0]!.line, 598_001);

  // Fold marks never make short output longer than it was, so what fit still fits.
  const short = Array.from({ length: 300 }, (_, n) => `${n}\n`.repeat(4)).join("");
  assert.equal(await clientStreamText(stream(short).value, "summary", undefined, { readArtifact: readSpill }), short);
  assert.equal(await clientStreamText(stream("same\n".repeat(50)).value, "summary", undefined, { readArtifact: readSpill }), "same\n… (49 more identical lines)\n", "while long runs still fold");

  // Under the bound the summary is read from the start of the output.
  const small = Array.from({ length: 5000 }, (_, n) => n === 4000 ? "src/app.ts:1:1 - error TS1: boom" : `line ${n + 1} ${"x".repeat(24)}`);
  const whole = stream(Buffer.from(small.join("\n") + "\n"), { tailBytes: 8 * 1024, spill: true });
  const summary = await clientStreamText(whole.value, "summary", "run-1", { readArtifact: whole.readSpill });
  assert.match(summary, /^line 1 x/u);
  assert.match(summary, /^L4001: /mu);

  // With a gap before the tail, no number can be right, so none is given.
  const tail = Buffer.from(`${Array.from({ length: 5000 }, (_, n) => n === 2500 ? "src/app.ts:1:1 - error TS1: boom" : `tail ${n}`).join("\n")}\n`);
  const gapped: ManagedOutputStreamEvidence = { stream: "stdout", totalBytes: 40 * 1024 * 1024, tail: new Uint8Array(tail), lossyBytes: 1, lossReasons: ["spill_cap_exceeded"], spill: { artifactId: "e".repeat(64), bytes: 1024 } };
  const unknown = await clientStreamText(gapped, "summary", "run-1", { readArtifact: async () => Buffer.alloc(1024, 0x61) });
  assert.match(unknown, /^src\/app\.ts:1:1 - error TS1: boom$/mu);
  assert.doesNotMatch(unknown, /^L\d+:/mu);
});
