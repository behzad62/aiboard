import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  applyMutant,
  codeSpansForLine,
  exitMeansSurvivorsFound,
  familyForPath,
  generateMutants,
  INITIAL_CARRY,
  runBreakItProbe,
  type MutationCommandRunner,
  type MutationFileSystem,
} from "../src/mutation-probe.js";

test("family detection covers the C family, Python, and unknown languages", () => {
  for (const ext of ["c", "h", "cpp", "cs", "java", "js", "ts", "tsx", "go", "rs", "kt", "swift"]) {
    assert.equal(familyForPath(`src/a.${ext}`), "c", ext);
  }
  assert.equal(familyForPath("src/a.py"), "python");
  assert.equal(familyForPath("src/a.xyz"), undefined);
});

test("C lexer skips line comments, block comments, strings, and chars", () => {
  const line = `if (a == b) { // check "==" here`;
  const { spans } = codeSpansForLine(line, "c", INITIAL_CARRY);
  const commentStart = line.indexOf("//");
  assert.ok(spans.every((s) => s.end <= commentStart));
  assert.ok(spans.some((s) => s.start <= line.indexOf("==") && line.indexOf("==") + 2 <= s.end));

  const quoted = `const s = "a == b"; if (x != y) {}`;
  const q = codeSpansForLine(quoted, "c", INITIAL_CARRY);
  assert.ok(!q.spans.some((s) => quoted.indexOf('"a') >= s.start && quoted.indexOf('"a') < s.end));
  assert.ok(q.spans.some((s) => quoted.indexOf("!=") >= s.start));

  const block = codeSpansForLine("/* a == b */ if (x) {}", "c", INITIAL_CARRY);
  assert.ok(!block.spans.some((s) => 3 >= s.start && 3 < s.end));
});

test("C lexer carries block comments and template strings across lines", () => {
  const first = codeSpansForLine("/* start", "c", INITIAL_CARRY);
  assert.equal(first.next.inBlockComment, true);
  const second = codeSpansForLine("a == b", "c", first.next);
  assert.deepEqual(second.spans, []);
  const third = codeSpansForLine("end */ x == y", "c", second.next);
  assert.equal(third.next.inBlockComment, false);
  assert.ok(third.spans.length > 0);
});

test("Python lexer skips comments, strings, and triple-quoted blocks", () => {
  const line = `if a == b:  # check "!=" here`;
  const { spans } = codeSpansForLine(line, "python", INITIAL_CARRY);
  const hash = line.indexOf("#");
  assert.ok(spans.every((s) => s.end <= hash));
  const triple = codeSpansForLine('"""', "python", INITIAL_CARRY);
  assert.equal(triple.next.inTripleString, '"""');
  const inside = codeSpansForLine("a == b", "python", triple.next);
  assert.deepEqual(inside.spans, []);
  const single = codeSpansForLine(`s = 'a == b'`, "python", INITIAL_CARRY);
  assert.ok(single.spans.length === 1 && single.spans[0].end <= single.spans[0].start + 4);
});

test("mutator touches code on changed lines only, never comments or strings", () => {
  const content = [
    "if (a == b) { // ==",
    'const s = "!=";',
    "return x;",
  ].join("\n");
  const mutants = generateMutants([{ path: "src/a.ts", content, changedLineNumbers: [1, 2, 3] }]);
  assert.ok(mutants.some((m) => m.lineNumber === 1 && m.original === "=="));
  assert.ok(!mutants.some((m) => m.lineNumber === 2), "string contents are never mutated");
  const unchanged = generateMutants([{ path: "src/a.ts", content, changedLineNumbers: [3] }]);
  assert.ok(!unchanged.some((m) => m.lineNumber === 1), "unchanged lines are never mutated");
});

test("mutator covers comparisons, booleans, arithmetic, and logical operators per family", () => {
  const c = generateMutants([{
    path: "src/a.ts",
    content: ["if (a && b || c) {", "  return true;", "}", "const d = x + y - z;"].join("\n"),
    changedLineNumbers: [1, 2, 4],
  }]);
  assert.ok(c.some((m) => m.original === "&&" && m.mutated === "||"));
  assert.ok(c.some((m) => m.original === "||" && m.mutated === "&&"));
  assert.ok(c.some((m) => m.original === "true" && m.mutated === "false"));
  assert.ok(c.some((m) => m.original === "+" && m.mutated === "-"));
  const py = generateMutants([{
    path: "src/a.py",
    content: "if a and b or True:\n    return False",
    changedLineNumbers: [1, 2],
  }]);
  assert.ok(py.some((m) => m.original === "and" && m.mutated === "or"));
  assert.ok(py.some((m) => m.original === "True" && m.mutated === "False"));
});

test("mutator does not touch ++, --, ->, =>, or word substrings", () => {
  const mutants = generateMutants([{
    path: "src/a.ts",
    content: "i++; j--; f->g; (x) => x; const atruem = 1;",
    changedLineNumbers: [1],
  }]);
  assert.ok(!mutants.some((m) => m.original === "+" || m.original === "-"), JSON.stringify(mutants));
  assert.ok(!mutants.some((m) => m.original === "true"));
});

function memorySystem(files: Map<string, string>): MutationFileSystem & { copies: string[]; writes: string[] } {
  const copies: string[] = [];
  const writes: string[] = [];
  return {
    copies,
    writes,
    readFile: (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`missing ${path}`);
      return content;
    },
    writeFile: (path, content) => {
      writes.push(path);
      files.set(path, content);
    },
    createDisposableCopy: () => {
      const root = `copy_${copies.length}`;
      copies.push(root);
      return root;
    },
    cleanupDisposableCopy: () => {},
    join: (root, path) => `${root}::${path}`,
  };
}

function scriptedRunner(script: Array<{ exitCode: number | null; stdout?: string; stderr?: string }>): MutationCommandRunner {
  let now = 0;
  let calls = 0;
  return {
    now: () => now,
    run: async () => {
      const step = script[Math.min(calls, script.length - 1)];
      calls += 1;
      now += 5;
      return { exitCode: step.exitCode, stdout: step.stdout ?? "", stderr: step.stderr ?? "", timedOut: false };
    },
  };
}

test("probe runs the built-in mutator in a disposable copy and restores exactly", async () => {
  const original = "if (a == b) {\n  return true;\n}";
  const files = new Map([["src/a.ts", original]]);
  const before = createHash("sha256").update(files.get("src/a.ts") as string).digest("hex");
  const fs = memorySystem(files);
  // First mutant caught (exit 1), second survives (exit 0).
  const result = await runBreakItProbe({
    files: [{ path: "src/a.ts", content: original, changedLineNumbers: [1, 2] }],
    affectedTestCommand: { command: "npm", args: ["test"] },
    maxMutants: 10,
    maxMs: 10_000,
    perCommandTimeoutMs: 1000,
    runner: scriptedRunner([{ exitCode: 1 }, { exitCode: 0 }]),
    fileSystem: fs,
  });
  assert.equal(result.rung, "builtin_mutator");
  assert.equal(result.blocks, false);
  assert.equal(fs.copies.length, 1);
  assert.ok(fs.writes.every((w) => w.startsWith("copy_0::")), "original tree is never written");
  assert.equal(createHash("sha256").update(files.get("src/a.ts") as string).digest("hex"), before);
});

test("non-building mutants are discarded, not counted as caught", async () => {
  const original = "if (a == b) {\n  return true;\n}";
  const fs = memorySystem(new Map([["src/a.ts", original]]));
  const result = await runBreakItProbe({
    files: [{ path: "src/a.ts", content: original, changedLineNumbers: [1] }],
    affectedTestCommand: { command: "npm", args: ["test"] },
    buildCommand: { command: "npm", args: ["run", "build"] },
    maxMutants: 1,
    maxMs: 10_000,
    perCommandTimeoutMs: 1000,
    runner: scriptedRunner([{ exitCode: 2 }]),
    fileSystem: fs,
  });
  assert.equal(result.mutantsDiscardedNonBuilding, 1);
  assert.equal(result.mutantsCaught, 0);
  assert.deepEqual(result.survivors, []);
});

test("caps are recorded with partial coverage", async () => {
  const original = "if (a == b && c || d) {\n  return true;\n}";
  const fs = memorySystem(new Map([["src/a.ts", original]]));
  const result = await runBreakItProbe({
    files: [{ path: "src/a.ts", content: original, changedLineNumbers: [1, 2] }],
    affectedTestCommand: { command: "npm", args: ["test"] },
    maxMutants: 1,
    maxMs: 10_000,
    perCommandTimeoutMs: 1000,
    runner: scriptedRunner([{ exitCode: 1 }]),
    fileSystem: fs,
  });
  assert.equal(result.partial, true);
  assert.match(result.partialReason ?? "", /count cap/);
  assert.ok(result.mutantsGenerated > result.mutantsExecuted);
});

test("applyMutant is exact and refuses stale content", () => {
  const [mutant] = generateMutants([{ path: "src/a.ts", content: "if (a == b) {}", changedLineNumbers: [1] }]);
  const applied = applyMutant("if (a == b) {}", mutant);
  assert.ok(applied.includes(mutant.mutated));
  assert.throws(() => applyMutant("if (a != b) {}", mutant), /stale content/);
});

test("repair N6: text blocks, verbatim, and raw strings are never mutated", () => {
  const textBlock = generateMutants([{
    path: "A.java",
    content: `String s = """\n  a == b && c\n  """;\nint x = 1;`,
    changedLineNumbers: [2],
  }]);
  assert.deepEqual(textBlock, [], "Java text block contents are never mutated");
  const verbatim = generateMutants([{
    path: "A.cs",
    content: `var s = @"line1\n a == b\n";`,
    changedLineNumbers: [2],
  }]);
  assert.deepEqual(verbatim, [], "C# multiline verbatim contents are never mutated");
  const rustRaw = generateMutants([{ path: "a.rs", content: `let s = r#"a "== b" "#;`, changedLineNumbers: [1] }]);
  assert.deepEqual(rustRaw, [], "Rust raw string contents are never mutated");
  const cppRaw = generateMutants([{ path: "a.cpp", content: `auto s = R"(a "== b)";`, changedLineNumbers: [1] }]);
  assert.deepEqual(cppRaw, [], "C++ raw string contents are never mutated");
  const kotlin = generateMutants([{ path: "A.kt", content: `val s = """\n  x > 1 || y\n"""`, changedLineNumbers: [2] }]);
  assert.deepEqual(kotlin, [], "Kotlin raw string contents are never mutated");
});

test("repair N6: nested block comments, regex literals, and generics", () => {
  const nested = generateMutants([{ path: "a.rs", content: "/* outer /* inner */ x == y */ let z = 1;", changedLineNumbers: [1] }]);
  assert.deepEqual(nested, [], "comment contents under nesting are never mutated");
  const regex = generateMutants([{ path: "a.js", content: "const r = /a==b/; const q = x == y;", changedLineNumbers: [1] }]);
  assert.ok(regex.some((m) => m.original === "==" && m.column === 30), "regex contents skipped, real comparison kept");
  assert.ok(!regex.some((m) => m.column < 20), "no mutant inside the regex literal");
  const generics = generateMutants([{ path: "A.java", content: "List<String> xs = new ArrayList<>();", changedLineNumbers: [1] }]);
  assert.deepEqual(generics, [], "generic brackets produce no mutants");
  const lifetime = generateMutants([{ path: "a.rs", content: "fn f<'a>(x: &'a i32) -> bool { *x == 1 }", changedLineNumbers: [1] }]);
  assert.ok(lifetime.some((m) => m.original === "=="), "lifetime brackets skipped, comparison kept");
  assert.ok(!lifetime.some((m) => m.original === "<" || m.original === ">" || m.original === ">="));
  const relational = generateMutants([{ path: "A.java", content: "if (a < b && c > d) { return a < b; }", changedLineNumbers: [1] }]);
  assert.ok(relational.some((m) => m.original === "<"), "spaced relational operators still mutate");
});

test("repair B10: a crashed project tool steps down, survivors are carried", async () => {
  const fs = memorySystem(new Map([["src/a.ts", "x == y"]]));
  const crashed = await runBreakItProbe({
    files: [{ path: "src/a.ts", content: "x == y", changedLineNumbers: [1] }],
    affectedTestCommand: { command: "npm", args: ["test"] },
    configuredTool: { name: "stryker", command: "npx", args: ["stryker", "run"], parseSurvivors: () => ["m1", "m2"] },
    maxMutants: 5,
    maxMs: 1000,
    perCommandTimeoutMs: 100,
    runner: scriptedRunner([{ exitCode: 127, stderr: "not found" }]),
    fileSystem: fs,
  });
  assert.notEqual(crashed.rung, "project_tool");
  assert.equal(crashed.rung, "builtin_mutator");
  assert.ok(crashed.notes.some((n) => n.includes("stepping down")));
  const carried = await runBreakItProbe({
    files: [{ path: "src/a.ts", content: "x == y", changedLineNumbers: [1] }],
    affectedTestCommand: { command: "npm", args: ["test"] },
    configuredTool: { name: "stryker", command: "npx", args: ["stryker", "run"], parseSurvivors: () => ["m1", "m2"] },
    maxMutants: 5,
    maxMs: 1000,
    perCommandTimeoutMs: 100,
    runner: scriptedRunner([{ exitCode: 0, stdout: "survivors: m1, m2" }]),
    fileSystem: memorySystem(new Map([["src/a.ts", "x == y"]])),
  });
  assert.equal(carried.rung, "project_tool");
  assert.deepEqual(carried.toolSurvivors, ["m1", "m2"]);
  assert.equal(carried.blocks, false);
});

test("repair N7: compiled-family failures without a build oracle are unknown, not caught", async () => {
  const original = "if (a == b) { return; }";
  const result = await runBreakItProbe({
    files: [{ path: "A.java", content: original, changedLineNumbers: [1] }],
    affectedTestCommand: { command: "mvn", args: ["test"] },
    maxMutants: 5,
    maxMs: 10_000,
    perCommandTimeoutMs: 1000,
    runner: scriptedRunner([{ exitCode: 1, stderr: "COMPILATION ERROR" }]),
    fileSystem: memorySystem(new Map([["A.java", original]])),
  });
  assert.equal(result.mutantsCaught, 0);
  assert.ok(result.mutantsCaughtUnverified > 0);
  assert.ok(result.notes.some((n) => n.includes("without a build oracle")));
});

test("repair N6 (cycle 2): Rust multiline plain strings and JSX brackets are never mutated", () => {
  const rust = generateMutants([{
    path: "a.rs",
    content: `let s = "line1\n a == b && c\n";\nlet y = p == q;`,
    changedLineNumbers: [1, 2, 3, 4],
  }]);
  assert.ok(!rust.some((m) => m.lineNumber === 2), `string continuation line is never mutated: ${JSON.stringify(rust)}`);
  assert.ok(rust.some((m) => m.lineNumber === 4 && m.original === "=="), "real comparison after the string still mutates");
  const jsx = generateMutants([{
    path: "A.tsx",
    content: `return <div className="a">{x > 1}</div>;`,
    changedLineNumbers: [1],
  }]);
  assert.ok(!jsx.some((m) => m.original === "<"), `JSX element brackets are never mutated: ${JSON.stringify(jsx)}`);
  assert.ok(jsx.some((m) => m.original === ">"), "the genuine comparison inside JSX still mutates");
  const tsxComparison = generateMutants([{
    path: "A.tsx",
    content: `if (a < b && c > d) { return a < b; }`,
    changedLineNumbers: [1],
  }]);
  assert.ok(tsxComparison.some((m) => m.original === "<"), "spaced relational operators in tsx still mutate");
});

test("repair NB4: a configured tool with no survivor parser is a failed rung, never 0 survivors", async () => {
  const fs = memorySystem(new Map([["src/a.ts", "if (a == b) {}"]]));
  const result = await runBreakItProbe({
    files: [{ path: "src/a.ts", content: "if (a == b) {}", changedLineNumbers: [1] }],
    affectedTestCommand: { command: "npm", args: ["test"] },
    configuredTool: {
      name: "stryker",
      command: "npx",
      args: ["stryker", "run"],
      parseSurvivors: undefined as unknown as (stdout: string, stderr: string) => readonly string[],
    },
    maxMutants: 5,
    maxMs: 1000,
    perCommandTimeoutMs: 100,
    runner: scriptedRunner([{ exitCode: 0, stdout: "Mutation score 60%. Survived: 4" }]),
    fileSystem: fs,
  });
  assert.notEqual(result.rung, "project_tool");
  assert.deepEqual(result.toolSurvivors, []);
  assert.ok(result.notes.some((n) => n.includes("no survivor parser")), JSON.stringify(result.notes));
});

test("repair NB4: survivors-found exits parse and keep survivors per tool docs", () => {
  assert.equal(exitMeansSurvivorsFound("cargo-mutants", 2), true);
  assert.equal(exitMeansSurvivorsFound("cargo_mutants", 2), true);
  assert.equal(exitMeansSurvivorsFound("cargo-mutants", 0), false);
  assert.equal(exitMeansSurvivorsFound("cargo-mutants", 1), false);
  assert.equal(exitMeansSurvivorsFound("mutmut", 2), true);
  assert.equal(exitMeansSurvivorsFound("mutmut", 3), false, "fatal bit is never a completed survivors run");
  assert.equal(exitMeansSurvivorsFound("mutmut", 7), false, "fatal bit is never a completed survivors run");
  assert.equal(exitMeansSurvivorsFound("mutmut", 0), false);
  assert.equal(exitMeansSurvivorsFound("stryker", 2), false);
  assert.equal(exitMeansSurvivorsFound("stryker", null), false);
});

test("repair NB4: cargo-mutants exit 2 keeps the MISSED survivors", async () => {
  const fs = memorySystem(new Map([["src/lib.rs", "if x == y { true }"]]));
  const result = await runBreakItProbe({
    files: [{ path: "src/lib.rs", content: "if x == y { true }", changedLineNumbers: [1] }],
    affectedTestCommand: { command: "cargo", args: ["test"] },
    configuredTool: {
      name: "cargo-mutants",
      command: "cargo",
      args: ["mutants", "--file"],
      parseSurvivors: (stdout) => stdout.split("\n").filter((line) => line.startsWith("MISSED")),
    },
    maxMutants: 5,
    maxMs: 1000,
    perCommandTimeoutMs: 100,
    runner: scriptedRunner([{
      exitCode: 2,
      stdout: "MISSED src/lib.rs:1: replace == with !=\nMISSED src/lib.rs:1: replace true with false",
    }]),
    fileSystem: fs,
  });
  assert.equal(result.rung, "project_tool");
  assert.deepEqual(result.toolSurvivors, [
    "MISSED src/lib.rs:1: replace == with !=",
    "MISSED src/lib.rs:1: replace true with false",
  ]);
  assert.ok(result.notes.some((n) => n.includes("survivors found per tool docs")));
  assert.equal(result.blocks, false);
});

test("repair NB4: mutmut non-zero exit with survivors keeps the survivors", async () => {
  const fs = memorySystem(new Map([["src/calc.py", "def add(a, b):\n    return a + b\n"]]));
  const result = await runBreakItProbe({
    files: [{ path: "src/calc.py", content: "def add(a, b):\n    return a + b\n", changedLineNumbers: [1, 2] }],
    affectedTestCommand: { command: "pytest", args: [] },
    configuredTool: {
      name: "mutmut",
      command: "mutmut",
      args: ["run"],
      parseSurvivors: (stdout) => stdout.split("\n").filter((line) => line.startsWith("- ")),
    },
    maxMutants: 5,
    maxMs: 1000,
    perCommandTimeoutMs: 100,
    runner: scriptedRunner([{
      exitCode: 2,
      stdout: "Survived 🙁 (2)\n\n- src/calc.py:2: calc.add\n- src/calc.py:2: calc.add-2\n",
    }]),
    fileSystem: fs,
  });
  assert.equal(result.rung, "project_tool");
  assert.deepEqual(result.toolSurvivors, ["- src/calc.py:2: calc.add", "- src/calc.py:2: calc.add-2"]);
  assert.equal(result.blocks, false);
});

test("repair N2 (cycle 3): mutmut fatal exit is a failed rung, never a completed project-tool run", async () => {
  const fs = memorySystem(new Map([["src/calc.py", "def add(a, b):\n    return a + b\n"]]));
  const result = await runBreakItProbe({
    files: [{ path: "src/calc.py", content: "def add(a, b):\n    return a + b\n", changedLineNumbers: [1, 2] }],
    affectedTestCommand: { command: "pytest", args: [] },
    configuredTool: {
      name: "mutmut",
      command: "mutmut",
      args: ["run"],
      parseSurvivors: (stdout) => stdout.split("\n").filter((line) => line.startsWith("- ")),
    },
    maxMutants: 5,
    maxMs: 1000,
    perCommandTimeoutMs: 100,
    runner: scriptedRunner([{
      exitCode: 3,
      stdout: "fatal error\n- src/calc.py:2: calc.add\n",
    }]),
    fileSystem: fs,
  });
  assert.notEqual(result.rung, "project_tool");
  assert.deepEqual(result.toolSurvivors, []);
  assert.ok(result.notes.some((note) => note.includes("tool exit 3")));
});

test("repair NB4: every supported tool report format parses through rung 1", async () => {
  const cases: Array<{
    name: string; file: string; content: string; exitCode: number;
    stdout: string; parse: (stdout: string, stderr: string) => readonly string[]; expected: readonly string[];
  }> = [
    {
      name: "stryker", file: "src/a.ts", content: "if (x == y) return true;", exitCode: 0,
      stdout: JSON.stringify({
        schemaVersion: "1",
        files: { "src/a.ts": { mutants: [{ id: "0", status: "Survived" }, { id: "1", status: "Killed" }] } },
      }),
      parse: (stdout) => {
        const report = JSON.parse(stdout) as { files: Record<string, { mutants: Array<{ id: string; status: string }> }> };
        return Object.values(report.files).flatMap((f) => f.mutants.filter((m) => m.status === "Survived").map((m) => m.id));
      },
      expected: ["0"],
    },
    {
      name: "stryker.net", file: "src/Calc.cs", content: "if (a == b) return true;", exitCode: 0,
      stdout: JSON.stringify({
        schemaVersion: "1",
        files: { "src/Calc.cs": { language: "cs", mutants: [{ id: "7", status: "Survived" }] } },
      }),
      parse: (stdout) => {
        const report = JSON.parse(stdout) as { files: Record<string, { mutants: Array<{ id: string; status: string }> }> };
        return Object.values(report.files).flatMap((f) => f.mutants.filter((m) => m.status === "Survived").map((m) => m.id));
      },
      expected: ["7"],
    },
    {
      name: "pit", file: "src/Calc.java", content: "if (a == b) return true;", exitCode: 0,
      stdout: ">> Generated 3 mutations Killed 2 (67%)\n- com.x.Calc::add survived (line 12)\n",
      parse: (stdout) => stdout.split("\n").filter((line) => line.includes("survived")),
      expected: ["- com.x.Calc::add survived (line 12)"],
    },
    {
      name: "mutmut", file: "src/calc.py", content: "def add(a, b):\n    return a + b\n", exitCode: 0,
      stdout: "Survived 🙁 (1)\n\n- src/calc.py:2: calc.add\n",
      parse: (stdout) => stdout.split("\n").filter((line) => line.startsWith("- ")),
      expected: ["- src/calc.py:2: calc.add"],
    },
    {
      name: "cargo-mutants", file: "src/lib.rs", content: "if x == y { true }", exitCode: 0,
      stdout: "Caught src/lib.rs:1: replace == with !=\nMISSED src/lib.rs:1: replace true with false\n",
      parse: (stdout) => stdout.split("\n").filter((line) => line.startsWith("MISSED")),
      expected: ["MISSED src/lib.rs:1: replace true with false"],
    },
    {
      name: "mull", file: "src/cart.cpp", content: "if (a == b) return true;", exitCode: 0,
      stdout: "[info] Survived mutants (1):\nsrc/cart.cpp:12:5: warning: Survived: Replaced == with !=\n",
      parse: (stdout) => stdout.split("\n").filter((line) => line.includes("Survived:")),
      expected: ["src/cart.cpp:12:5: warning: Survived: Replaced == with !="],
    },
  ];
  for (const tool of cases) {
    const result = await runBreakItProbe({
      files: [{ path: tool.file, content: tool.content, changedLineNumbers: [1] }],
      affectedTestCommand: { command: "test", args: [] },
      configuredTool: { name: tool.name, command: tool.name, args: ["run"], parseSurvivors: tool.parse },
      maxMutants: 5,
      maxMs: 1000,
      perCommandTimeoutMs: 100,
      runner: scriptedRunner([{ exitCode: tool.exitCode, stdout: tool.stdout }]),
      fileSystem: memorySystem(new Map([[tool.file, tool.content]])),
    });
    assert.equal(result.rung, "project_tool", tool.name);
    assert.deepEqual(result.toolSurvivors, tool.expected, tool.name);
    assert.equal(result.blocks, false, tool.name);
  }
});

test("unknown language or missing test command yields not_available", async () => {
  const fs = memorySystem(new Map());
  const noTool = await runBreakItProbe({
    files: [{ path: "src/a.xyz", content: "???", changedLineNumbers: [1] }],
    affectedTestCommand: { command: "npm", args: ["test"] },
    maxMutants: 5,
    maxMs: 1000,
    perCommandTimeoutMs: 100,
    runner: scriptedRunner([]),
    fileSystem: fs,
  });
  assert.equal(noTool.rung, "not_available");
  const noCommand = await runBreakItProbe({
    files: [{ path: "src/a.ts", content: "if (a == b) {}", changedLineNumbers: [1] }],
    maxMutants: 5,
    maxMs: 1000,
    perCommandTimeoutMs: 100,
    runner: scriptedRunner([]),
    fileSystem: fs,
  });
  assert.equal(noCommand.rung, "not_available");
});

test("configured project tool runs scoped to changed files in a disposable copy", async () => {
  const files = new Map([["src/a.ts", "if (a == b) {}"]]);
  const fs = memorySystem(files);
  let seenArgs: readonly string[] = [];
  const runner: MutationCommandRunner = {
    now: () => 0,
    run: async (input) => {
      seenArgs = input.args;
      return { exitCode: 0, stdout: "survivors: 0", stderr: "", timedOut: false };
    },
  };
  const result = await runBreakItProbe({
    files: [{ path: "src/a.ts", content: "if (a == b) {}", changedLineNumbers: [1] }],
    affectedTestCommand: { command: "npm", args: ["test"] },
    configuredTool: { name: "stryker", command: "npx", args: ["stryker", "run"], parseSurvivors: () => [] },
    maxMutants: 5,
    maxMs: 1000,
    perCommandTimeoutMs: 100,
    runner,
    fileSystem: fs,
  });
  assert.equal(result.rung, "project_tool");
  assert.equal(result.blocks, false);
  assert.ok(seenArgs.includes("src/a.ts"));
});
