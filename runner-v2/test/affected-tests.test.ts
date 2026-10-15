import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  computeAffectedTests,
  detectWideningTriggers,
  isDocumentationPath,
  isRunnableTestFile,
  followLspReferences,
  LSP_CLOSURE_NODE_CAP,
  moduleGraphTests,
  parseAnyModuleGraph,
  parseCargoGraph,
  parseGoGraph,
  parseMavenGradleGraph,
  stripGradleComments,
} from "../src/affected-tests.js";
import type { CodeIntelligenceResult, CodeLocation } from "../src/language-intelligence.js";

function okResult(paths: string[]): CodeIntelligenceResult<CodeLocation> {
  return {
    status: "ok",
    results: paths.map((path, i) => ({ path, line: i + 1, column: 1, preview: "ref" })),
    truncated: false,
  };
}

const FULL = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"];

test("rung 1: configured impact tool wins and its rung is recorded", () => {
  const result = computeAffectedTests({
    changedFiles: ["src/a.ts"],
    impactTool: { configured: true, run: () => ["test/a.test.ts"] },
    fullSuiteTests: FULL,
  });
  assert.equal(result.rung, "impact_tool");
  assert.deepEqual(result.tests, ["test/a.test.ts"]);
  assert.deepEqual(result.attemptedRungs.map((r) => r.rung), ["impact_tool"]);
});

test("rung 1 failure steps down to LSP instead of an empty selection", () => {
  const result = computeAffectedTests({
    changedFiles: ["src/a.ts"],
    impactTool: { configured: true, run: () => { throw new Error("tool crashed"); } },
    lsp: { query: () => okResult(["test/a.test.ts", "src/a.ts"]) },
    fullSuiteTests: FULL,
  });
  assert.equal(result.rung, "lsp_references");
  assert.deepEqual(result.tests, ["test/a.test.ts"]);
  assert.deepEqual(result.attemptedRungs.map((r) => `${r.rung}:${r.status}`), ["impact_tool:failed", "lsp_references:ok"]);
});

test("unsupported_language is a failed rung, never an empty selection", () => {
  const result = computeAffectedTests({
    changedFiles: ["src/a.ts"],
    lsp: { query: () => ({ status: "unsupported_language", results: [], truncated: false }) },
    moduleGraph: {
      allFiles: ["packages/a/src/a.ts", "packages/a/test/a.test.ts"],
      fileContents: new Map([
        ["package.json", JSON.stringify({ workspaces: ["packages/*"] })],
        ["packages/a/package.json", JSON.stringify({ name: "a" })],
      ]),
    },
    fullSuiteTests: FULL,
  });
  assert.equal(result.rung, "full_suite");
  assert.deepEqual(result.tests, FULL);
  assert.ok(result.attemptedRungs.some((r) => r.rung === "lsp_references" && r.status === "failed"));
  assert.ok(result.attemptedRungs.some((r) => r.rung === "module_graph" && r.status === "failed"));
});

test("npm workspace module graph selects the changed module and its dependents", () => {
  const fileContents = new Map([
    ["package.json", JSON.stringify({ workspaces: ["packages/*"] })],
    ["packages/a/package.json", JSON.stringify({ name: "a" })],
    ["packages/b/package.json", JSON.stringify({ name: "b", dependencies: { a: "*" } })],
    ["packages/c/package.json", JSON.stringify({ name: "c" })],
  ]);
  const allFiles = [
    "packages/a/src/a.ts", "packages/a/test/a.test.ts",
    "packages/b/src/b.ts", "packages/b/test/b.test.ts",
    "packages/c/test/c.test.ts",
  ];
  const graph = parseAnyModuleGraph(fileContents, allFiles);
  assert.equal(graph?.kind, "npm");
  const tests = moduleGraphTests(graph!, ["packages/a/src/a.ts"], allFiles);
  assert.deepEqual(tests, ["packages/a/test/a.test.ts", "packages/b/test/b.test.ts"]);
});

test("dotnet module graph follows ProjectReference edges", () => {
  const fileContents = new Map([
    ["src/A/A.csproj", `<Project><ItemGroup><ProjectReference Include="..\\B\\B.csproj" /></ItemGroup></Project>`],
    ["src/B/B.csproj", `<Project></Project>`],
  ]);
  const graph = parseAnyModuleGraph(fileContents, []);
  assert.equal(graph?.kind, "dotnet");
  const tests = moduleGraphTests(graph!, ["src/B/B.cs"], ["src/A/ATest.cs", "src/B/BTest.cs"]);
  assert.deepEqual(tests, ["src/A/ATest.cs", "src/B/BTest.cs"]);
});

test("cmake module graph follows target_link_libraries edges", () => {
  const fileContents = new Map([
    ["core/CMakeLists.txt", "add_library(core core.cpp)"],
    ["app/CMakeLists.txt", "add_executable(app app.cpp)\ntarget_link_libraries(app PRIVATE core)"],
  ]);
  const graph = parseAnyModuleGraph(fileContents, []);
  assert.equal(graph?.kind, "cmake");
  const tests = moduleGraphTests(
    graph!,
    ["core/core.cpp"],
    ["core/core.cpp", "core/test_core.cpp", "app/app.cpp", "app/app_test.cpp", "other/other.cpp"],
  );
  assert.deepEqual(tests, ["app/app_test.cpp", "core/test_core.cpp"]);
});

test("widening triggers step down to at least the module graph", () => {
  for (const file of ["package-lock.json", "tsconfig.json", "shared.h", "gen/generated.client.ts", "mystery.xyz123"]) {
    const reasons = detectWideningTriggers([file]);
    assert.equal(reasons.length, 1, file);
  }
  const result = computeAffectedTests({
    changedFiles: ["package-lock.json"],
    impactTool: { configured: true, run: () => ["test/a.test.ts"] },
    lsp: { query: () => okResult(["test/a.test.ts"]) },
    moduleGraph: {
      allFiles: ["packages/a/test/a.test.ts"],
      fileContents: new Map([
        ["package.json", JSON.stringify({ workspaces: ["packages/*"] })],
        ["packages/a/package.json", JSON.stringify({ name: "a" })],
      ]),
    },
    fullSuiteTests: FULL,
  });
  assert.equal(result.widened, true);
  assert.equal(result.rung, "module_graph");
  assert.deepEqual(result.tests, ["packages/a/test/a.test.ts"]);
});

test("widening with no module graph lands on the full suite", () => {
  const result = computeAffectedTests({
    changedFiles: ["Cargo.lock"],
    impactTool: { configured: true, run: () => ["test/a.test.ts"] },
    fullSuiteTests: FULL,
  });
  assert.equal(result.widened, true);
  assert.equal(result.rung, "full_suite");
  assert.deepEqual(result.tests, FULL);
});

test("repair B7: lockfile widening selects every module test, never empty", () => {
  const fileContents = new Map([
    ["package.json", JSON.stringify({ workspaces: ["packages/*"] })],
    ["packages/a/package.json", JSON.stringify({ name: "a" })],
    ["packages/b/package.json", JSON.stringify({ name: "b", dependencies: { a: "*" } })],
  ]);
  const allFiles = ["package-lock.json", "packages/a/src/a.ts", "packages/a/test/a.test.ts", "packages/b/test/b.test.ts"];
  const result = computeAffectedTests({
    changedFiles: ["package-lock.json"],
    moduleGraph: { allFiles, fileContents },
    fullSuiteTests: ["packages/a/test/a.test.ts", "packages/b/test/b.test.ts"],
  });
  assert.equal(result.rung, "module_graph");
  assert.equal(result.widened, true);
  assert.deepEqual(result.tests, ["packages/a/test/a.test.ts", "packages/b/test/b.test.ts"]);
});

test("repair B7: realistic xUnit layout selects dependent test projects", () => {
  const fileContents = new Map([
    ["src/App/App.csproj", `<Project Sdk="Microsoft.NET.Sdk"></Project>`],
    ["tests/App.Tests/App.Tests.csproj", `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="..\\..\\src\\App\\App.csproj" /></ItemGroup></Project>`],
  ]);
  const allFiles = ["src/App/Calc.cs", "tests/App.Tests/CalcTests.cs", "tests/App.Tests/UnitTest1.cs"];
  const result = computeAffectedTests({
    changedFiles: ["src/App/Calc.cs"],
    moduleGraph: { allFiles, fileContents },
    fullSuiteTests: ["tests/App.Tests/CalcTests.cs"],
  });
  assert.equal(result.rung, "module_graph");
  assert.deepEqual(result.tests, ["tests/App.Tests/CalcTests.cs", "tests/App.Tests/UnitTest1.cs"]);
  const props = computeAffectedTests({
    changedFiles: ["Directory.Build.props"],
    moduleGraph: { allFiles, fileContents },
    fullSuiteTests: ["tests/App.Tests/CalcTests.cs"],
  });
  assert.equal(props.widened, true);
  assert.deepEqual(props.tests, ["tests/App.Tests/CalcTests.cs", "tests/App.Tests/UnitTest1.cs"]);
});

test("repair B7: files outside every module and inline-test crates land on the full suite", () => {
  const npmFiles = new Map([
    ["package.json", JSON.stringify({ workspaces: ["packages/*"] })],
    ["packages/a/package.json", JSON.stringify({ name: "a" })],
  ]);
  const root = computeAffectedTests({
    changedFiles: ["scripts/shared.ts"],
    moduleGraph: {
      allFiles: ["packages/a/src/a.ts", "packages/a/test/a.test.ts"],
      fileContents: npmFiles,
    },
    fullSuiteTests: ["packages/a/test/a.test.ts"],
  });
  assert.equal(root.rung, "full_suite");
  assert.deepEqual(root.tests, ["packages/a/test/a.test.ts"]);
  const cargo = computeAffectedTests({
    changedFiles: ["src/lib.rs"],
    moduleGraph: {
      allFiles: ["src/lib.rs"],
      fileContents: new Map([["Cargo.toml", `[package]\nname = "c"\n`]]),
    },
    fullSuiteTests: ["cargo test"],
  });
  assert.equal(cargo.rung, "module_graph");
  assert.deepEqual(cargo.tests, ["src/lib.rs"]);
});

test("repair B7: impact tool without a run function is a failed rung", () => {
  const result = computeAffectedTests({
    changedFiles: ["src/a.ts"],
    impactTool: { configured: true },
    fullSuiteTests: FULL,
  });
  assert.equal(result.rung, "full_suite");
  assert.deepEqual(result.tests, FULL);
  assert.ok(result.attemptedRungs.some((r) => r.rung === "impact_tool" && r.status === "failed"));
});

test("repair B7/N10: zero or truncated LSP references step down, never empty", () => {
  const zero = computeAffectedTests({
    changedFiles: ["src/a.ts"],
    lsp: { query: () => ({ status: "ok", results: [], truncated: false }) },
    fullSuiteTests: FULL,
  });
  assert.equal(zero.rung, "full_suite");
  assert.deepEqual(zero.tests, FULL);
  const truncated = computeAffectedTests({
    changedFiles: ["src/a.ts"],
    lsp: { query: () => ({ status: "ok", results: [okResult(["test/a.test.ts"]).results[0]], truncated: true }) },
    fullSuiteTests: FULL,
  });
  assert.equal(truncated.rung, "full_suite");
  assert.deepEqual(truncated.tests, FULL);
  assert.ok(truncated.attemptedRungs.some((r) => r.rung === "lsp_references" && r.status === "failed"));
});

test("repair B8: Go dependents follow package imports", () => {
  const fileContents = new Map([["go.mod", "module example.com/m\n"]]);
  const allFiles = ["util/u.go", "util/u_test.go", "api/api.go", "api/api_test.go"];
  const fallback = computeAffectedTests({
    changedFiles: ["util/u.go"],
    moduleGraph: { allFiles, fileContents },
    fullSuiteTests: ["api/api_test.go", "util/u_test.go"],
  });
  assert.deepEqual(fallback.tests, ["api/api_test.go", "util/u_test.go"]);
  const sourceContents = new Map([
    ["util/u.go", "package util\nfunc U() int { return 1 }\n"],
    ["api/api.go", "package api\nimport \"example.com/m/util\"\nfunc A() int { return util.U() }\n"],
  ]);
  const graph = parseAnyModuleGraph(fileContents, allFiles, sourceContents);
  assert.equal(graph?.kind, "go");
  assert.equal(graph?.edgesUnknown, undefined);
  const mapped = moduleGraphTests(graph!, ["util/u.go"], allFiles);
  assert.deepEqual(mapped, ["api/api_test.go", "util/u_test.go"]);
  const unrelated = moduleGraphTests(graph!, ["other/o.go"], [...allFiles, "other/o.go", "other/o_test.go"]);
  assert.deepEqual(unrelated, []);
});

test("repair B8: Gradle dependents follow project() dependencies", () => {
  const fileContents = new Map([
    ["settings.gradle", "include ':core'\ninclude ':app'"],
    ["app/build.gradle", "dependencies { implementation project(':core') }"],
  ]);
  const allFiles = ["core/src/main/java/C.java", "core/src/test/java/CTest.java", "app/src/test/java/ATest.java"];
  const result = computeAffectedTests({
    changedFiles: ["core/src/main/java/C.java"],
    moduleGraph: { allFiles, fileContents },
    fullSuiteTests: ["core/src/test/java/CTest.java"],
  });
  assert.equal(result.rung, "module_graph");
  assert.deepEqual(result.tests, ["app/src/test/java/ATest.java", "core/src/test/java/CTest.java"]);
});

test("no configured rung at all still lands on the full suite, never empty", () => {
  const result = computeAffectedTests({ changedFiles: ["src/a.ts"], fullSuiteTests: FULL });
  assert.equal(result.rung, "full_suite");
  assert.deepEqual(result.tests, FULL);
  assert.ok(result.attemptedRungs.length >= 3);
});

// ---------------------------------------------------------------------------
// Repair cycle 2: round-2 review findings (NB1-NB3, N7-N8).
// Each asserts the actual selection, not only which rung fired.
// ---------------------------------------------------------------------------

test("repair NB1: a mapped change plus an unmapped shared file widens to the full suite", () => {
  const fileContents = new Map([
    ["package.json", JSON.stringify({ workspaces: ["packages/*"] })],
    ["packages/a/package.json", JSON.stringify({ name: "a" })],
    ["packages/b/package.json", JSON.stringify({ name: "b", dependencies: { a: "*" } })],
    ["packages/c/package.json", JSON.stringify({ name: "c" })],
  ]);
  const allFiles = [
    "packages/a/src/a.ts", "packages/a/test/a.test.ts",
    "packages/b/src/b.ts", "packages/b/test/b.test.ts",
    "packages/c/test/c.test.ts", "shared/util.ts",
  ];
  const full = ["packages/a/test/a.test.ts", "packages/b/test/b.test.ts", "packages/c/test/c.test.ts"];
  const result = computeAffectedTests({
    changedFiles: ["packages/a/src/a.ts", "shared/util.ts"],
    moduleGraph: { allFiles, fileContents },
    fullSuiteTests: full,
  });
  assert.equal(result.rung, "full_suite");
  assert.deepEqual(result.tests, full);
  const moduleRung = result.attemptedRungs.find((r) => r.rung === "module_graph");
  assert.equal(moduleRung?.status, "failed");
  assert.match(moduleRung?.reason ?? "", /shared\/util\.ts/);
});

test("repair NB1/NB2: Gradle core+app change selects core's own tests too", () => {
  const fileContents = new Map([
    ["settings.gradle.kts", `rootProject.name = "shop"\ninclude(":app", ":core")\n`],
    ["app/build.gradle.kts", `dependencies { implementation(project(":core")) }`],
    ["core/build.gradle.kts", `plugins { java }`],
  ]);
  const allFiles = [
    "core/src/main/java/C.java", "core/src/test/java/CTest.java",
    "app/src/main/java/A.java", "app/src/test/java/ATest.java",
  ];
  const result = computeAffectedTests({
    changedFiles: ["core/src/main/java/C.java", "app/src/main/java/A.java"],
    moduleGraph: { allFiles, fileContents },
    fullSuiteTests: ["gradle test"],
  });
  assert.equal(result.rung, "module_graph");
  assert.deepEqual(result.tests, ["app/src/test/java/ATest.java", "core/src/test/java/CTest.java"]);
});

test("repair NB2: Cargo inline tables, table-form deps, and dev-dependencies select dependents", () => {
  const allFiles = [
    "crates/core/src/lib.rs", "crates/core/tests/cart.rs",
    "crates/cli/src/main.rs", "crates/cli/tests/cli.rs", "crates/other/tests/o.rs",
  ];
  const full = ["ALL"];
  // Inline table with an array before the path dependency (ubiquitous serde form).
  const features = new Map([
    ["Cargo.toml", `[workspace]\nmembers = ["crates/core", "crates/cli"]\n`],
    ["crates/core/Cargo.toml", `[package]\nname = "shop-core"\nversion = "0.1.0"\n`],
    ["crates/cli/Cargo.toml", `[package]\nname = "shop-cli"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1", features = ["derive"] }\nshop-core = { path = "../core" }\n`],
  ]);
  const graph = parseCargoGraph(features);
  assert.ok(graph?.modules.some((m) => m.name === "shop-cli" && m.dependsOn.includes("shop-core")));
  const selected = computeAffectedTests({
    changedFiles: ["crates/core/src/lib.rs"],
    moduleGraph: { allFiles, fileContents: features },
    fullSuiteTests: full,
  });
  assert.deepEqual(selected.tests, ["crates/cli/src/main.rs", "crates/cli/tests/cli.rs", "crates/core/src/lib.rs", "crates/core/tests/cart.rs"]);
  // [dependencies.shop-core] table form.
  const tableForm = new Map([
    ...features,
    ["crates/cli/Cargo.toml", `[package]\nname = "shop-cli"\n\n[dependencies.shop-core]\npath = "../core"\n`],
  ]);
  const tableSelected = computeAffectedTests({
    changedFiles: ["crates/core/src/lib.rs"],
    moduleGraph: { allFiles, fileContents: tableForm },
    fullSuiteTests: full,
  });
  assert.deepEqual(tableSelected.tests, ["crates/cli/src/main.rs", "crates/cli/tests/cli.rs", "crates/core/src/lib.rs", "crates/core/tests/cart.rs"]);
  // dev-dependencies only.
  const devOnly = new Map([
    ...features,
    ["crates/cli/Cargo.toml", `[package]\nname = "shop-cli"\nversion = "0.1.0"\n\n[dev-dependencies]\nshop-core = { path = "../core" }\n`],
  ]);
  const devSelected = computeAffectedTests({
    changedFiles: ["crates/core/src/lib.rs"],
    moduleGraph: { allFiles, fileContents: devOnly },
    fullSuiteTests: full,
  });
  assert.deepEqual(devSelected.tests, ["crates/cli/src/main.rs", "crates/cli/tests/cli.rs", "crates/core/src/lib.rs", "crates/core/tests/cart.rs"]);
});

test("repair NB2: Go multi-module replace wiring selects cross-module dependents", () => {
  const fileContents = new Map([
    ["go.mod", "module example.com/app\n\ngo 1.22\n\nrequire example.com/lib v0.0.0\n\nreplace example.com/lib => ./lib\n"],
    ["lib/go.mod", "module example.com/lib\n\ngo 1.22\n"],
  ]);
  const allFiles = [
    "main.go", "api/api.go", "api/api_test.go",
    "lib/lib.go", "lib/lib_test.go", "other/o.go", "other/o_test.go",
  ];
  const sourceContents = new Map([
    ["api/api.go", `package api\n\nimport (\n\t"fmt"\n\t"example.com/lib"\n)\n`],
    ["lib/lib.go", "package lib"],
    ["main.go", `package main\nimport "example.com/app/api"`],
    ["other/o.go", "package other"],
  ]);
  const graph = parseGoGraph(fileContents, allFiles, sourceContents);
  assert.equal(graph?.kind, "go");
  assert.equal(graph?.edgesUnknown, undefined);
  const result = computeAffectedTests({
    changedFiles: ["lib/lib.go"],
    moduleGraph: { allFiles, fileContents, sourceContents },
    fullSuiteTests: ["./..."],
  });
  assert.equal(result.rung, "module_graph");
  assert.deepEqual(result.tests, ["api/api_test.go", "lib/lib_test.go"]);
});

test("repair NB2: Gradle Kotlin DSL and comma-separated includes parse every module", () => {
  const kts = new Map([
    ["settings.gradle.kts", `rootProject.name = "shop"\ninclude(":app", ":core")\n`],
    ["app/build.gradle.kts", `dependencies { implementation(project(":core")) }`],
    ["core/build.gradle.kts", `plugins { java }`],
  ]);
  const graph = parseMavenGradleGraph(kts);
  assert.ok(graph?.modules.some((m) => m.name === "core" && m.dir === "core"), JSON.stringify(graph?.modules));
  assert.ok(graph?.modules.some((m) => m.name === "app" && m.dependsOn.includes("core")));
  const comma = new Map([
    ["settings.gradle", `include 'app', 'core', 'web'`],
    ["web/build.gradle", `dependencies { implementation project(':core') }`],
  ]);
  const commaGraph = parseMavenGradleGraph(comma);
  assert.ok(commaGraph?.modules.some((m) => m.name === "web" && m.dependsOn.includes("core")), JSON.stringify(commaGraph?.modules));
  const result = computeAffectedTests({
    changedFiles: ["core/src/main/java/C.java", "app/src/main/java/A.java"],
    moduleGraph: {
      allFiles: ["core/src/main/java/C.java", "core/src/test/java/CTest.java", "app/src/test/java/ATest.java", "web/src/test/java/WTest.java"],
      fileContents: comma,
    },
    fullSuiteTests: ["gradle test"],
  });
  assert.deepEqual(result.tests, ["app/src/test/java/ATest.java", "core/src/test/java/CTest.java", "web/src/test/java/WTest.java"]);
});

test("repair NB3: LSP references follow importers transitively to test files", () => {
  // src/a.ts <- src/b.ts <- test/b.test.ts: changing a must select test b.
  const importers = new Map([
    ["src/a.ts", ["src/b.ts"]],
    ["src/b.ts", ["test/b.test.ts"]],
    ["src/c.ts", ["test/c.test.ts"]],
  ]);
  const lsp = {
    query: (file: string) => okResult(importers.get(file) ?? []),
  };
  const tests = followLspReferences(lsp, ["src/a.ts"]);
  assert.deepEqual(tests, ["test/b.test.ts"]);
  const result = computeAffectedTests({
    changedFiles: ["src/a.ts"],
    lsp,
    fullSuiteTests: ["test/b.test.ts", "test/c.test.ts"],
  });
  assert.equal(result.rung, "lsp_references");
  assert.deepEqual(result.tests, ["test/b.test.ts"]);
});

test("repair NB3: a failed transitive hop or a breached cap steps down, never partial", () => {
  const importers = new Map([["src/a.ts", ["src/b.ts"]], ["src/b.ts", ["test/b.test.ts"]]]);
  const truncatedMidChain = computeAffectedTests({
    changedFiles: ["src/a.ts"],
    lsp: {
      query: (file: string) => file === "src/b.ts"
        ? { status: "ok" as const, results: [], truncated: true }
        : okResult(importers.get(file) ?? []),
    },
    fullSuiteTests: FULL,
  });
  assert.equal(truncatedMidChain.rung, "full_suite");
  assert.deepEqual(truncatedMidChain.tests, FULL);
  // A chain longer than the cap cannot be followed completely: full suite.
  const chain = (file: string) => {
    const n = Number(file.slice(1));
    if (!Number.isSafeInteger(n)) return okResult([]);
    return okResult([`f${n + 1}`]);
  };
  const capped = computeAffectedTests({
    changedFiles: ["f0"],
    lsp: { query: chain },
    fullSuiteTests: FULL,
  });
  assert.ok(LSP_CLOSURE_NODE_CAP >= 1000);
  assert.equal(capped.rung, "full_suite");
  assert.deepEqual(capped.tests, FULL);
  const capRung = capped.attemptedRungs.find((r) => r.rung === "lsp_references");
  assert.match(capRung?.reason ?? "", /exceeded/);
});

test("repair NB3: this repo's real import graph selects every transitive importer", () => {
  const root = resolve(process.cwd(), "runner-v2");
  const collect = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...collect(rel));
      else if (/\.tsx?$/.test(entry.name)) out.push(`runner-v2/${rel}`);
    }
    return out;
  };
  const files = [...collect("src"), ...collect("test")];
  assert.ok(files.length > 100, "repo file set is realistic");
  const fileSet = new Set(files);
  const direct = new Map<string, string[]>();
  for (const file of files) {
    const content = readFileSync(resolve(process.cwd(), file), "utf8");
    for (const match of content.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      let target = resolve(process.cwd(), dirname(file), match[1]).replaceAll("\\", "/");
      target = target.replace(/\.js$/, ".ts");
      const rel = target.slice(`${process.cwd()}/`.length);
      if (fileSet.has(rel)) {
        const list = direct.get(rel) ?? [];
        list.push(file);
        direct.set(rel, list);
      }
    }
  }
  const closureTests = (start: string): string[] => {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.pop() as string;
      for (const importer of direct.get(current) ?? []) {
        if (!seen.has(importer)) {
          seen.add(importer);
          queue.push(importer);
        }
      }
    }
    return [...seen].filter((f) => f.includes("/test/")).sort();
  };
  const changed = "runner-v2/src/evidence-store.ts";
  const full = files.filter((f) => f.includes("/test/"));
  const expected = closureTests(changed);
  assert.ok(expected.length > 50, `transitive importer set is realistic (${expected.length})`);
  const lsp = {
    query: (file: string) => okResult((direct.get(file) ?? []).slice().sort()),
  };
  const result = computeAffectedTests({ changedFiles: [changed], lsp, fullSuiteTests: full });
  assert.equal(result.rung, "lsp_references");
  assert.ok(result.tests.includes("runner-v2/test/evidence-tools.test.ts"));
  assert.ok(result.tests.includes("runner-v2/test/sqlite-evidence-store.test.ts"));
  for (const testFile of expected) {
    assert.ok(result.tests.includes(testFile), `transitive importer ${testFile} is selected`);
  }
  assert.ok(result.tests.length < full.length, "selection stays narrow when the graph is known");
});

test("repair N7: build/test config files widen the ladder", () => {
  for (const file of ["jest.config.js", "vitest.config.ts", "runner-v2/tsconfig.build.json", "tsconfig.worker.json", ".env", ".env.local", "Dockerfile", "dockerfile.prod"]) {
    const reasons = detectWideningTriggers([file]);
    assert.equal(reasons.length, 1, file);
  }
});

test("repair N8: Maven uses the module artifactId, not the parent's", () => {
  const fileContents = new Map([
    ["pom.xml", `<project><groupId>g</groupId><artifactId>shop-parent</artifactId><packaging>pom</packaging><modules><module>core</module><module>api</module><module>other</module></modules></project>`],
    ["core/pom.xml", `<project><parent><groupId>g</groupId><artifactId>shop-parent</artifactId></parent><artifactId>shop-core</artifactId></project>`],
    ["api/pom.xml", `<project><parent><groupId>g</groupId><artifactId>shop-parent</artifactId></parent><artifactId>shop-api</artifactId><dependencies><dependency><groupId>g</groupId><artifactId>shop-core</artifactId></dependency></dependencies></project>`],
    ["other/pom.xml", `<project><parent><groupId>g</groupId><artifactId>shop-parent</artifactId></parent><artifactId>other</artifactId></project>`],
  ]);
  const graph = parseMavenGradleGraph(fileContents);
  assert.ok(graph?.modules.some((m) => m.name === "shop-core" && m.dir === "core"), JSON.stringify(graph?.modules));
  assert.ok(!graph?.modules.some((m) => m.name === "shop-parent" && m.dir === "core"));
  const result = computeAffectedTests({
    changedFiles: ["core/src/main/java/C.java"],
    moduleGraph: {
      allFiles: ["core/src/main/java/C.java", "core/src/test/java/CTest.java", "api/src/test/java/ApiTest.java", "other/src/test/java/OTest.java"],
      fileContents,
    },
    fullSuiteTests: ["mvn test"],
  });
  assert.deepEqual(result.tests, ["api/src/test/java/ApiTest.java", "core/src/test/java/CTest.java"]);
});

// ---------------------------------------------------------------------------
// Repair cycle 3: round-3 review findings (NB5-NB9) and requested hardening.
// Each test asserts the selected files, plus the opposite safe direction.
// ---------------------------------------------------------------------------

test("repair NB5: shared test identity covers specs, test dirs, and content-defined test projects on LSP and module rungs", () => {
  const npmFiles = new Map([
    ["package.json", JSON.stringify({ workspaces: ["packages/*"] })],
    ["packages/a/package.json", JSON.stringify({ name: "a" })],
    ["packages/b/package.json", JSON.stringify({ name: "b", dependencies: { a: "*" } })],
  ]);
  const npmAll = [
    "packages/a/src/cart.ts", "packages/a/src/cart.spec.ts",
    "packages/a/widget_test.ts", "packages/a/test/unit.py",
    "packages/a/tests/e2e_spec.rb", "packages/a/__tests__/legacy.js",
    "packages/b/test/b.test.ts", "tests/root.spec.ts",
  ];
  const npm = computeAffectedTests({
    changedFiles: ["packages/a/src/cart.ts"],
    moduleGraph: { allFiles: npmAll, fileContents: npmFiles },
    fullSuiteTests: ["packages/b/test/b.test.ts"],
  });
  assert.deepEqual(npm.tests, [
    "packages/a/__tests__/legacy.js",
    "packages/a/src/cart.spec.ts",
    "packages/a/test/unit.py",
    "packages/a/tests/e2e_spec.rb",
    "packages/a/widget_test.ts",
    "packages/b/test/b.test.ts",
  ]);

  const lsp = computeAffectedTests({
    changedFiles: ["src/cart.ts"],
    lsp: { query: (file) => okResult(file === "src/cart.ts"
      ? ["src/cart.spec.ts", "src/cart_test.ts", "test/nested.py"] : []) },
    fullSuiteTests: ["test/nested.py"],
  });
  assert.equal(lsp.rung, "lsp_references");
  assert.deepEqual(lsp.tests, ["src/cart.spec.ts", "src/cart_test.ts", "test/nested.py"]);

  const dotnetFiles = new Map([
    ["src/Shop.Core/Shop.Core.csproj", `<Project />`],
    ["src/Shop.Web/Shop.Web.csproj", `<Project><ItemGroup><ProjectReference Include="..\\Shop.Core\\Shop.Core.csproj" /></ItemGroup></Project>`],
    ["src/Shop.Web.Specs/Shop.Web.Specs.csproj", `<Project><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /><PackageReference Include="xunit" /></ItemGroup><ItemGroup><ProjectReference Include="..\\Shop.Web\\Shop.Web.csproj" /></ItemGroup></Project>`],
  ]);
  const dotnet = computeAffectedTests({
    changedFiles: ["src/Shop.Core/Core.cs"],
    moduleGraph: {
      allFiles: ["src/Shop.Core/Core.cs", "src/Shop.Web/Web.cs", "src/Shop.Web.Specs/CheckoutSpecs.cs", "src/Shop.Web.Specs/WhenPaying.cs", "src/Shop.Web.Specs/Shop.Web.Specs.csproj"],
      fileContents: dotnetFiles,
    },
    fullSuiteTests: ["dotnet test"],
  });
  assert.deepEqual(dotnet.tests, ["src/Shop.Web.Specs/CheckoutSpecs.cs", "src/Shop.Web.Specs/WhenPaying.cs"]);

  const javaFiles = new Map([
    ["core/pom.xml", `<project><artifactId>core</artifactId></project>`],
    ["specs/pom.xml", `<project><artifactId>specs</artifactId><dependencies><dependency><groupId>g</groupId><artifactId>core</artifactId></dependency><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId></dependency></dependencies></project>`],
  ]);
  const java = computeAffectedTests({
    changedFiles: ["core/src/main/java/Core.java"],
    moduleGraph: {
      allFiles: ["core/src/main/java/Core.java", "specs/src/test/java/WhenPaying.java"],
      fileContents: javaFiles,
    },
    fullSuiteTests: ["mvn test"],
  });
  // Maven test identity comes from `src/test/**`, never from junit in a pom (R4-B4).
  assert.deepEqual(java.tests, ["specs/src/test/java/WhenPaying.java"]);
});

test("repair NB6: changed or new tests are always selected on impact, LSP, and module-graph rungs", () => {
  const impact = computeAffectedTests({
    changedFiles: ["src/a.ts", "test/changed.test.ts"],
    impactTool: { configured: true, run: () => ["test/affected.test.ts"] },
    fullSuiteTests: ["test/affected.test.ts", "test/changed.test.ts"],
  });
  assert.deepEqual(impact.tests, ["test/affected.test.ts", "test/changed.test.ts"]);
  assert.match(impact.attemptedRungs[0].reason, /changed test/);

  const lsp = computeAffectedTests({
    changedFiles: ["src/a.ts", "test/changed.test.ts", "tests/root.spec.ts"],
    lsp: { query: (file) => okResult(file === "src/a.ts" ? ["test/affected.test.ts"] : []) },
    fullSuiteTests: ["test/affected.test.ts", "test/changed.test.ts", "tests/root.spec.ts"],
  });
  assert.deepEqual(lsp.tests, ["test/affected.test.ts", "test/changed.test.ts", "tests/root.spec.ts"]);
  assert.match(lsp.attemptedRungs[1].reason, /changed test/);

  const files = new Map([
    ["package.json", JSON.stringify({ workspaces: ["packages/*"] })],
    ["packages/a/package.json", JSON.stringify({ name: "a" })],
  ]);
  const allFiles = ["packages/a/src/a.ts", "packages/a/test/affected.test.ts", "tests/e2e/checkout.spec.ts"];
  const moduleGraph = computeAffectedTests({
    changedFiles: ["packages/a/src/a.ts", "tests/e2e/checkout.spec.ts"],
    moduleGraph: { allFiles, fileContents: files },
    fullSuiteTests: ["packages/a/test/affected.test.ts", "tests/e2e/checkout.spec.ts"],
  });
  assert.deepEqual(moduleGraph.tests, ["packages/a/test/affected.test.ts", "tests/e2e/checkout.spec.ts"]);
  assert.match(moduleGraph.attemptedRungs[2].reason, /changed test/);
});

test("repair NB7: Cargo selects inline unit-test targets for every affected crate alongside tests/ files", () => {
  const fileContents = new Map([
    ["Cargo.toml", `[workspace]\nmembers = ["crates/core", "crates/cli", "crates/other"]\n`],
    ["crates/core/Cargo.toml", `[package]\nname = "shop-core"\nversion = "0.1.0"\n`],
    ["crates/cli/Cargo.toml", `[package]\nname = "shop-cli"\nversion = "0.1.0"\n\n[dependencies]\nshop-core = { path = "../core" }\n`],
    ["crates/other/Cargo.toml", `[package]\nname = "shop-other"\nversion = "0.1.0"\n`],
  ]);
  const allFiles = [
    "crates/core/src/lib.rs", "crates/core/src/cart.rs", "crates/core/tests/core.rs",
    "crates/cli/src/main.rs", "crates/cli/tests/cli.rs",
    "crates/other/src/lib.rs", "crates/other/tests/other.rs",
  ];
  const result = computeAffectedTests({
    changedFiles: ["crates/core/src/cart.rs"],
    moduleGraph: { allFiles, fileContents },
    fullSuiteTests: ["cargo test --workspace"],
  });
  assert.deepEqual(result.tests, [
    "crates/cli/src/main.rs",
    "crates/cli/tests/cli.rs",
    "crates/core/src/lib.rs",
    "crates/core/tests/core.rs",
  ]);
});

test("repair NB8: Gradle typesafe project accessors map nested and kebab names; unreadable accessors fail closed", () => {
  const allFiles = [
    "app/src/test/kotlin/AppTest.kt", "core/src/test/kotlin/CoreTest.kt",
    "web/src/test/kotlin/WebTest.kt", "libs/core/src/test/kotlin/LibCoreTest.kt",
    "mobile/src/test/kotlin/MobileTest.kt", "my-lib/core-api/src/test/kotlin/ApiTest.kt",
    "other/src/test/kotlin/OtherTest.kt",
  ];
  const fileContents = new Map([
    ["settings.gradle.kts", `enableFeaturePreview("TYPESAFE_PROJECT_ACCESSORS")\ninclude(":app", ":core", ":web", ":libs:core", ":mobile", ":my-lib:core-api", ":other")\n`],
    ["app/build.gradle.kts", `dependencies { implementation(projects.core) }\n`],
    ["core/build.gradle.kts", ``],
    ["web/build.gradle.kts", `dependencies { implementation(projects.libs.core) }\n`],
    ["libs/core/build.gradle.kts", ``],
    ["mobile/build.gradle.kts", `dependencies { implementation(projects.myLib.coreApi) }\n`],
    ["my-lib/core-api/build.gradle.kts", ``],
    ["other/build.gradle.kts", ``],
  ]);
  const result = computeAffectedTests({
    changedFiles: ["core/src/main/kotlin/Core.kt", "libs/core/src/main/kotlin/Lib.kt", "my-lib/core-api/src/main/kotlin/Api.kt"],
    moduleGraph: { allFiles, fileContents },
    fullSuiteTests: ["gradle test"],
  });
  assert.deepEqual(result.tests, [
    "app/src/test/kotlin/AppTest.kt",
    "core/src/test/kotlin/CoreTest.kt",
    "libs/core/src/test/kotlin/LibCoreTest.kt",
    "mobile/src/test/kotlin/MobileTest.kt",
    "my-lib/core-api/src/test/kotlin/ApiTest.kt",
    "web/src/test/kotlin/WebTest.kt",
  ]);

  const unknown = new Map(fileContents);
  unknown.set("app/build.gradle.kts", `dependencies { implementation(projects.notIncluded) }\n`);
  const graph = parseMavenGradleGraph(unknown);
  assert.equal(graph?.edgesUnknown, true);
  const fallback = computeAffectedTests({
    changedFiles: ["core/src/main/kotlin/Core.kt"],
    moduleGraph: { allFiles, fileContents: unknown },
    fullSuiteTests: ["gradle test"],
  });
  assert.deepEqual(fallback.tests, allFiles.slice().sort());
});

test("repair NB9: modern Cargo workspace syntax stays narrow to the dependent crates", () => {
  const fileContents = new Map([
    ["Cargo.toml", `[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "0.1.0"\n\n[workspace.dependencies]\nserde = { version = "1", features = ["derive"] }\nshop-core = { path = "crates/core" }\n`],
    ["crates/core/Cargo.toml", `[package]\nname = "shop-core"\nversion.workspace = true\n\n[dependencies]\nserde.workspace = true\nserde.version = "1"\n\n[[bin]]\nname = "core-tool"\npath = "src/bin/tool.rs"\n\n[[bench]]\nname = "cart"\nharness = false\n\n[[test]]\nname = "integration"\n\n[[example]]\nname = "demo"\n`],
    ["crates/cli/Cargo.toml", `[package]\nname = "shop-cli"\nversion.workspace = true\n\n[dependencies]\nshop-core = { workspace = true }\n`],
    ["crates/other/Cargo.toml", `[package]\nname = "shop-other"\nversion = "0.1.0"\n\n[dependencies]\nserde = { workspace = true }\n`],
  ]);
  const allFiles = [
    "crates/core/src/lib.rs", "crates/core/tests/core.rs",
    "crates/cli/src/main.rs", "crates/cli/tests/cli.rs",
    "crates/other/src/lib.rs", "crates/other/tests/other.rs",
  ];
  const result = computeAffectedTests({
    changedFiles: ["crates/core/src/lib.rs"],
    moduleGraph: { allFiles, fileContents },
    fullSuiteTests: ["cargo test --workspace"],
  });
  assert.deepEqual(result.tests, [
    "crates/cli/src/main.rs",
    "crates/cli/tests/cli.rs",
    "crates/core/src/lib.rs",
    "crates/core/tests/core.rs",
  ]);
  const graph = parseCargoGraph(fileContents);
  assert.equal(graph?.edgesUnknown, undefined);
  assert.ok(graph?.modules.some((module) => module.name === "shop-cli" && module.dependsOn.includes("shop-core")));

  const unreadableContents = new Map(fileContents);
  unreadableContents.set("crates/core/Cargo.toml", `[package]\nname = "shop-core"\nversion = "0.1.0"\n\n[dependencies]\nmissing-equals\n`);
  const unreadableGraph = parseCargoGraph(unreadableContents);
  assert.equal(unreadableGraph?.edgesUnknown, true);
  const failClosed = computeAffectedTests({
    changedFiles: ["crates/core/src/lib.rs"],
    moduleGraph: { allFiles, fileContents: unreadableContents },
    fullSuiteTests: ["cargo test --workspace"],
  });
  assert.deepEqual(failClosed.tests, allFiles.slice().sort());
});

test("repair cycle 3 hardening: understood docs select nothing and do not widen code, unknown types still widen", () => {
  for (const file of [
    "README.md", "docs/design.mdx", "README.txt", "spec.rst", "guide.adoc",
    "assets/logo.png", "assets/photo.jpg", "assets/photo.jpeg", "assets/hero.webp",
    "LICENSE", "CHANGELOG.md",
  ]) {
    assert.deepEqual(detectWideningTriggers([file]), [], file);
  }
  assert.deepEqual(detectWideningTriggers(["mystery.xyz123"]), ["unknown file type mystery.xyz123"]);

  const lsp = computeAffectedTests({
    changedFiles: ["src/a.ts", ".changeset/brave-owls.md"],
    lsp: { query: (file) => okResult(file === "src/a.ts" ? ["test/a.test.ts"] : []) },
    fullSuiteTests: ["test/a.test.ts", "test/b.test.ts"],
  });
  assert.deepEqual(lsp.tests, ["test/a.test.ts"]);

  const files = new Map([
    ["package.json", JSON.stringify({ workspaces: ["packages/*"] })],
    ["packages/a/package.json", JSON.stringify({ name: "a" })],
    ["packages/b/package.json", JSON.stringify({ name: "b" })],
  ]);
  const allFiles = ["packages/a/src/a.ts", "packages/a/test/a.test.ts", "packages/b/test/b.test.ts"];
  const moduleGraph = computeAffectedTests({
    changedFiles: ["packages/a/src/a.ts", "packages/a/CHANGELOG.md"],
    moduleGraph: { allFiles, fileContents: files },
    fullSuiteTests: ["packages/a/test/a.test.ts", "packages/b/test/b.test.ts"],
  });
  assert.deepEqual(moduleGraph.tests, ["packages/a/test/a.test.ts"]);

  const docsOnly = computeAffectedTests({
    changedFiles: ["README.md", "assets/logo.png"],
    lsp: { query: () => okResult([]) },
    moduleGraph: { allFiles, fileContents: files },
    fullSuiteTests: ["packages/a/test/a.test.ts", "packages/b/test/b.test.ts"],
  });
  assert.deepEqual(docsOnly.tests, []);
});

// ---------------------------------------------------------------------------
// Controller repair (after review r4): R4-B1..R4-B5 regressions, inverted.
// ---------------------------------------------------------------------------

test("R4-B1: code, build and dependency files are never documentation; CMakeLists.txt widens again", () => {
  for (const file of [
    "src/security.ts", "src/auth/Security.java", "lib/notice.js", "src/changes.ts", "app/authors.py",
    "src/license-check.ts", "src/readme-parser.ts", "src/security_test.go",
    "CMakeLists.txt", "core/CMakeLists.txt", "requirements.txt", "requirements-dev.txt",
    "tests/fixtures/expected_output.txt", "src/templates/welcome.txt", "src/icons/logo.svg",
    "package-lock.json", "tsconfig.json",
  ]) {
    assert.equal(isDocumentationPath(file), false, file);
  }
  for (const file of ["LICENSE", "LICENSE.md", "LICENSE-MIT", "LICENSE.txt", "README.txt", "CHANGELOG.md", "SECURITY.md", "docs/guide.md"]) {
    assert.equal(isDocumentationPath(file), true, file);
  }
  const security = computeAffectedTests({
    changedFiles: ["src/security.ts"],
    lsp: { query: (file) => okResult(file === "src/security.ts" ? ["test/a.test.ts", "test/b.test.ts"] : []) },
    fullSuiteTests: FULL,
  });
  assert.equal(security.rung, "lsp_references");
  assert.deepEqual(security.tests, ["test/a.test.ts", "test/b.test.ts"]);
  for (const file of ["CMakeLists.txt", "requirements.txt", "tests/fixtures/expected_output.txt"]) {
    const result = computeAffectedTests({ changedFiles: [file], fullSuiteTests: FULL });
    assert.notEqual(result.rung, "no_tests_required", file);
    assert.ok(result.tests.length > 0, file);
  }
  assert.deepEqual(detectWideningTriggers(["CMakeLists.txt"]), ["build configuration CMakeLists.txt"]);
  const cmake = new Map([
    ["CMakeLists.txt", "add_subdirectory(core)"],
    ["core/CMakeLists.txt", "add_library(core core.cpp)"],
    ["app/CMakeLists.txt", "add_executable(app app.cpp)\ntarget_link_libraries(app PRIVATE core)"],
  ]);
  const widened = computeAffectedTests({
    changedFiles: ["CMakeLists.txt", "core/cart.cpp"],
    moduleGraph: { allFiles: ["core/cart.cpp", "core/tests/cart_test.cpp", "app/tests/app_test.cpp"], fileContents: cmake },
    fullSuiteTests: ["core/tests/cart_test.cpp", "app/tests/app_test.cpp"],
  });
  assert.equal(widened.widened, true);
  assert.deepEqual(widened.tests, ["app/tests/app_test.cpp", "core/tests/cart_test.cpp"]);
});

test("R4-B2: a co-changed test never masks an empty LSP or impact-tool answer for changed code", () => {
  const lsp = computeAffectedTests({
    changedFiles: ["src/money.ts", "src/money.test.ts"],
    lsp: { query: () => okResult([]) },
    fullSuiteTests: FULL,
  });
  assert.equal(lsp.rung, "full_suite");
  assert.equal(lsp.attemptedRungs.find((r) => r.rung === "lsp_references")?.status, "failed");
  const impact = computeAffectedTests({
    changedFiles: ["src/money.ts", "src/money.test.ts"],
    impactTool: { configured: true, run: () => [] },
    fullSuiteTests: FULL,
  });
  assert.equal(impact.rung, "full_suite");
  assert.equal(impact.attemptedRungs.find((r) => r.rung === "impact_tool")?.status, "failed");
  // Control: a successful answer still gets the co-changed test unioned in.
  const ok = computeAffectedTests({
    changedFiles: ["src/money.ts", "src/money.test.ts"],
    lsp: { query: (file) => okResult(file === "src/money.ts" ? ["test/a.test.ts"] : []) },
    fullSuiteTests: FULL,
  });
  assert.equal(ok.rung, "lsp_references");
  assert.deepEqual(ok.tests, ["src/money.test.ts", "test/a.test.ts"]);
  // Control: a test-only change selects exactly the changed test.
  const testOnly = computeAffectedTests({
    changedFiles: ["src/money.test.ts"],
    lsp: { query: () => okResult([]) },
    fullSuiteTests: FULL,
  });
  assert.equal(testOnly.rung, "lsp_references");
  assert.deepEqual(testOnly.tests, ["src/money.test.ts"]);
  // Source files named like tests are not tests (G3b).
  assert.equal(isRunnableTestFile("src/select-tests.ts"), false);
  assert.equal(isRunnableTestFile("runner-v2/src/affected-tests.ts"), false);
  assert.equal(isRunnableTestFile("src/SpeedTest.tsx"), false);
  assert.equal(isRunnableTestFile("src/test/java/CartTest.java"), true);
  assert.equal(isRunnableTestFile("cypress/e2e/login.cy.ts"), true);
  const g3b = computeAffectedTests({
    changedFiles: ["src/select-tests.ts"],
    lsp: { query: () => okResult([]) },
    fullSuiteTests: FULL,
  });
  assert.equal(g3b.rung, "full_suite");
});

test("R4-B3: test helpers, setup files and fixtures outside every module never become the selection", () => {
  const files = new Map([
    ["package.json", JSON.stringify({ workspaces: ["packages/*"] })],
    ["packages/a/package.json", JSON.stringify({ name: "a" })],
    ["packages/b/package.json", JSON.stringify({ name: "b" })],
  ]);
  const allFiles = ["packages/a/test/a.test.ts", "packages/b/test/b.test.ts", "test/helpers/db.ts", "test/setup.ts", "tests/fixtures/users.json"];
  const suite = ["packages/a/test/a.test.ts", "packages/b/test/b.test.ts"];
  for (const file of ["test/helpers/db.ts", "test/setup.ts", "tests/fixtures/users.json"]) {
    const result = computeAffectedTests({ changedFiles: [file], moduleGraph: { allFiles, fileContents: files }, fullSuiteTests: suite });
    assert.equal(result.rung, "full_suite", file);
    assert.deepEqual(result.tests, suite, file);
  }
  // LSP: a setup file with no importers fails the rung instead of selecting itself.
  const h4 = computeAffectedTests({ changedFiles: ["test/setup.ts"], lsp: { query: () => okResult([]) }, fullSuiteTests: suite });
  assert.equal(h4.rung, "full_suite");
  // LSP: a helper's referencers are followed and selected.
  const helper = computeAffectedTests({
    changedFiles: ["test/helpers/db.ts"],
    lsp: { query: (file) => okResult(file === "test/helpers/db.ts" ? ["packages/a/test/a.test.ts"] : []) },
    fullSuiteTests: suite,
  });
  assert.equal(helper.rung, "lsp_references");
  assert.deepEqual(helper.tests, ["packages/a/test/a.test.ts"]);
});

test("R4-B4: junit in a pom does not turn Maven modules or the root into test projects", () => {
  const junit = "<dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><scope>test</scope></dependency>";
  const files = new Map([
    ["pom.xml", `<project><artifactId>root</artifactId><modules><module>core</module><module>api</module></modules><dependencyManagement><dependencies>${junit}</dependencies></dependencyManagement></project>`],
    ["core/pom.xml", `<project><artifactId>core</artifactId><dependencies>${junit}</dependencies></project>`],
    ["api/pom.xml", `<project><artifactId>api</artifactId><dependencies><dependency><groupId>g</groupId><artifactId>core</artifactId></dependency>${junit}</dependencies></project>`],
    ["other/pom.xml", `<project><artifactId>other</artifactId></project>`],
  ]);
  const graph = parseMavenGradleGraph(files);
  assert.equal(graph?.testProjectDirs, undefined);
  const allFiles = [
    "core/src/main/java/Cart.java", "core/src/main/java/Tax.java", "core/src/test/java/CartTest.java",
    "api/src/main/java/Api.java", "api/src/test/java/ApiTest.java",
    "other/src/test/java/OtherTest.java", "tools/gen.py",
  ];
  const m1 = computeAffectedTests({
    changedFiles: ["core/src/main/java/Cart.java"],
    moduleGraph: { allFiles, fileContents: files },
    fullSuiteTests: ["core/src/test/java/CartTest.java", "api/src/test/java/ApiTest.java", "other/src/test/java/OtherTest.java"],
  });
  assert.equal(m1.rung, "module_graph");
  assert.ok(!m1.tests.some((file) => file.includes("/main/")), m1.tests.join(","));
  assert.ok(m1.tests.includes("core/src/test/java/CartTest.java"));
  assert.ok(m1.tests.includes("api/src/test/java/ApiTest.java"));
  const m2 = computeAffectedTests({
    changedFiles: ["core/src/main/java/Cart.java"],
    lsp: { query: () => okResult([]) },
    fullSuiteTests: ["core/src/test/java/CartTest.java"],
  });
  assert.equal(m2.rung, "full_suite");
});

test("R4-B5: Gradle project(path: ...) forms create edges; unreadable project() calls fail closed", () => {
  for (const dependency of [
    "implementation project(path: ':core')",
    "implementation(project(path = \":core\"))",
    "implementation project(path: ':core', configuration: 'default')",
  ]) {
    const files = new Map([
      ["settings.gradle", "include ':core', ':app'"],
      ["app/build.gradle", `dependencies {\n  ${dependency}\n}`],
    ]);
    const result = computeAffectedTests({
      changedFiles: ["core/src/main/kotlin/Cart.kt"],
      moduleGraph: {
        allFiles: ["core/src/main/kotlin/Cart.kt", "core/src/test/kotlin/CartTest.kt", "app/src/test/kotlin/AppTest.kt"],
        fileContents: files,
      },
      fullSuiteTests: ["core/src/test/kotlin/CartTest.kt", "app/src/test/kotlin/AppTest.kt"],
    });
    assert.deepEqual(result.tests, ["app/src/test/kotlin/AppTest.kt", "core/src/test/kotlin/CartTest.kt"], dependency);
  }
  const unreadable = parseMavenGradleGraph(new Map([
    ["settings.gradle", "include ':core', ':app'"],
    ["app/build.gradle", "dependencies {\n  implementation project(corePath)\n}"],
  ]));
  assert.equal(unreadable?.edgesUnknown, true);
});

test("R5-B1: Gradle project() paths built from templates or concatenation fail closed", () => {
  const allFiles = ["core/src/main/kotlin/Cart.kt", "core/src/test/kotlin/CartTest.kt", "app/src/test/kotlin/AppTest.kt"];
  const suite = ["core/src/test/kotlin/CartTest.kt", "app/src/test/kotlin/AppTest.kt"];
  for (const dependency of [
    "listOf(\"core\").forEach { implementation(project(\":$it\")) }",
    "implementation(project(\":${coreName}\"))",
    "implementation project(\":\" + coreName)",
  ]) {
    const files = new Map([
      ["settings.gradle", "include ':core', ':app'"],
      ["app/build.gradle", `dependencies {\n  ${dependency}\n}`],
    ]);
    assert.equal(parseMavenGradleGraph(files)?.edgesUnknown, true, dependency);
    const result = computeAffectedTests({ changedFiles: ["core/src/main/kotlin/Cart.kt"], moduleGraph: { allFiles, fileContents: files }, fullSuiteTests: suite });
    assert.deepEqual(result.tests, ["app/src/test/kotlin/AppTest.kt", "core/src/test/kotlin/CartTest.kt"], dependency);
  }
  // A literal edge to a module settings does not include also fails closed.
  const unknownModule = parseMavenGradleGraph(new Map([
    ["settings.gradle", "include ':core', ':app'"],
    ["app/build.gradle", "dependencies {\n  implementation project(':missing')\n}"],
  ]));
  assert.equal(unknownModule?.edgesUnknown, true);
  // Control: a plain literal edge stays precise.
  const literal = parseMavenGradleGraph(new Map([
    ["settings.gradle", "include ':core', ':app'"],
    ["app/build.gradle", "dependencies {\n  implementation project(':core')\n}"],
  ]));
  assert.equal(literal?.edgesUnknown, undefined);
});

test("R6-B1: Gradle edges inside cross-project blocks fail closed; configuration-only roots stay precise", () => {
  const allFiles = [
    "core/src/main/kotlin/Cart.kt", "core/src/test/kotlin/CartTest.kt",
    "app/src/test/kotlin/AppTest.kt", "data/src/test/kotlin/DataTest.kt",
  ];
  const suite = ["core/src/test/kotlin/CartTest.kt", "app/src/test/kotlin/AppTest.kt", "data/src/test/kotlin/DataTest.kt"];
  const settings = ["settings.gradle", "include ':core', ':app', ':data'"] as const;
  for (const root of [
    "project(':app') {\n  dependencies {\n    implementation project(':core')\n  }\n}",
    "subprojects {\n  dependencies {\n    implementation project(':core')\n  }\n}",
  ]) {
    const files = new Map([settings, ["build.gradle", root]]);
    const result = computeAffectedTests({ changedFiles: ["core/src/main/kotlin/Cart.kt"], moduleGraph: { allFiles, fileContents: files }, fullSuiteTests: suite });
    assert.ok(result.tests.includes("app/src/test/kotlin/AppTest.kt"), root);
    assert.ok(result.tests.includes("core/src/test/kotlin/CartTest.kt"), root);
  }
  // Configuration-only root + per-module dependencies: precise (data excluded).
  const precise = new Map([
    settings,
    ["build.gradle", "buildscript {\n  dependencies { classpath 'x:y:1' }\n}\nallprojects { repositories { mavenCentral() } }\nproject(':core') {\n  apply plugin: 'java'\n}\nproject(':app') {\n  apply plugin: 'java'\n}"],
    ["app/build.gradle", "dependencies {\n  implementation project(':core')\n  // implementation project(':legacy')\n}"],
  ]);
  const graph = parseMavenGradleGraph(precise);
  assert.equal(graph?.edgesUnknown, undefined);
  const narrow = computeAffectedTests({ changedFiles: ["core/src/main/kotlin/Cart.kt"], moduleGraph: { allFiles, fileContents: precise }, fullSuiteTests: suite });
  assert.equal(narrow.rung, "module_graph");
  assert.deepEqual(narrow.tests, ["app/src/test/kotlin/AppTest.kt", "core/src/test/kotlin/CartTest.kt"]);
  // findProject(":core") is read as an edge.
  const find = computeAffectedTests({
    changedFiles: ["core/src/main/kotlin/Cart.kt"],
    moduleGraph: { allFiles, fileContents: new Map([settings, ["app/build.gradle.kts", "dependencies {\n  implementation(findProject(\":core\")!!)\n}"]]) },
    fullSuiteTests: suite,
  });
  assert.deepEqual(find.tests, ["app/src/test/kotlin/AppTest.kt", "core/src/test/kotlin/CartTest.kt"]);
});

test("R7-B1: comment stripping is string-aware and never hides real Gradle edges", () => {
  assert.equal(
    stripGradleComments("a 'x//y' \"/*z*/\" // gone\nb /* gone */ c '''t//u''' \"esc\\\"//\""),
    "a 'x//y' \"/*z*/\"  \nb   c '''t//u''' \"esc\\\"//\"",
  );
  const allFiles = [
    "core/src/main/kotlin/Cart.kt", "core/src/test/kotlin/CartTest.kt",
    "app/src/test/kotlin/AppTest.kt", "data/src/test/kotlin/DataTest.kt",
  ];
  const suite = ["core/src/test/kotlin/CartTest.kt", "app/src/test/kotlin/AppTest.kt", "data/src/test/kotlin/DataTest.kt"];
  const settings = ["settings.gradle", "include ':core', ':app', ':data'"] as const;
  const shapes: Array<[string, string]> = [
    ["app/build.gradle", "android { packagingOptions { exclude 'META-INF/*.kotlin_module' } }\ndependencies {\n  implementation project(':core')\n}\njacoco { excludes = ['**/R.class'] }"],
    ["app/build.gradle", "test { include '**/*Test.class' }\ndependencies {\n  implementation project(':core')\n}\n/* trailing comment */"],
    ["app/build.gradle", "// copy libs/*\ndependencies {\n  implementation project(':core')\n}\n/** doc */"],
    ["app/build.gradle.kts", "tasks.test { exclude(\"gen/*\") }\ndependencies {\n  implementation(project(\":core\"))\n}\ntasks.test { exclude(\"**/Slow*\") }"],
    ["app/build.gradle", "repositories { maven { url 'https://repo.example.com/m2' } }; dependencies { implementation project(':core') }"],
    ["app/build.gradle", "dependencies {\n  implementation project(':core') { transitive = false }\n}"],
  ];
  for (const [path, body] of shapes) {
    const files = new Map([settings, [path, body]]);
    const result = computeAffectedTests({ changedFiles: ["core/src/main/kotlin/Cart.kt"], moduleGraph: { allFiles, fileContents: files }, fullSuiteTests: suite });
    assert.ok(result.tests.includes("app/src/test/kotlin/AppTest.kt"), body);
  }
});

test("R7 N1/N2: root-file and findProject edges fail closed; configuration-only roots stay precise", () => {
  const settings = ["settings.gradle", "include ':core', ':app', ':data'"] as const;
  for (const root of [
    "project(':app').with {\n  dependencies { implementation project(':core') }\n}",
    "project(':app').dependencies.add('implementation', project(':core'))",
    "findProject(':app')?.dependencies?.add('implementation', project(':core'))",
    "rootProject.subprojects.each { p -> p.dependencies.add('implementation', project(':core')) }",
  ]) {
    assert.equal(parseMavenGradleGraph(new Map([settings, ["build.gradle", root]]))?.edgesUnknown, true, root);
  }
  assert.equal(parseMavenGradleGraph(new Map([
    settings,
    ["app/build.gradle.kts", "dependencies {\n  findProject(\":core\")?.let { implementation(it) }\n}"],
  ]))?.edgesUnknown, true);
  // Controls: configuration-only root + per-module edges stay precise.
  const precise = parseMavenGradleGraph(new Map([
    settings,
    ["build.gradle", "plugins { id 'java' }\nallprojects { repositories { mavenCentral() } }\nsubprojects {\n  apply plugin: 'java'\n  dependencies { testImplementation 'junit:junit:4.13' }\n}\nproject(':core') {\n  apply plugin: 'java-library'\n}"],
    ["app/build.gradle", "dependencies {\n  implementation project(':core')\n}"],
  ]));
  assert.equal(precise?.edgesUnknown, undefined);
});

test("R8-B1: aggregation, CI-task and configuration roots stay precise on an unrelated change", () => {
  const allFiles = [
    "core/src/main/kotlin/Cart.kt", "core/src/test/kotlin/CartTest.kt",
    "app/src/test/kotlin/AppTest.kt", "data/src/main/kotlin/Data.kt", "data/src/test/kotlin/DataTest.kt",
  ];
  const suite = ["core/src/test/kotlin/CartTest.kt", "app/src/test/kotlin/AppTest.kt", "data/src/test/kotlin/DataTest.kt"];
  const settings = ["settings.gradle.kts", "include(\":core\", \":app\", \":data\")"] as const;
  const app = ["app/build.gradle.kts", "dependencies {\n  implementation(project(\":core\"))\n}"] as const;
  for (const root of [
    "plugins { id(\"org.jetbrains.kotlinx.kover\") }\ndependencies {\n  kover(project(\":app\"))\n  kover(project(\":core\"))\n}",
    "plugins { id(\"org.jetbrains.dokka\") }\ndependencies {\n  dokka(project(\":app\"))\n}",
    "plugins { id(\"jacoco-report-aggregation\") }\ndependencies {\n  jacocoAggregation(project(\":app\"))\n}",
    "tasks.register(\"ci\") {\n  dependsOn(project(\":app\").tasks.named(\"check\"))\n}",
    "findProject(\":app\")?.let { it.version = \"1.0\" }",
  ]) {
    const files = new Map<string, string>([settings, app, ["build.gradle.kts", root]]);
    assert.notEqual(parseMavenGradleGraph(files)?.edgesUnknown, true, root);
    const result = computeAffectedTests({ changedFiles: ["data/src/main/kotlin/Data.kt"], moduleGraph: { allFiles, fileContents: files }, fullSuiteTests: suite });
    assert.equal(result.rung, "module_graph", root);
    assert.deepEqual(result.tests, ["data/src/test/kotlin/DataTest.kt"], root);
    const core = computeAffectedTests({ changedFiles: ["core/src/main/kotlin/Cart.kt"], moduleGraph: { allFiles, fileContents: files }, fullSuiteTests: suite });
    assert.ok(core.tests.includes("app/src/test/kotlin/AppTest.kt") && !core.tests.includes("data/src/test/kotlin/DataTest.kt"), root);
  }
});

test("R9: dependency-block project references that are not plain literals fail closed (module files)", () => {
  const allFiles = [
    "core/src/main/kotlin/Cart.kt", "core/src/test/kotlin/CartTest.kt",
    "app/src/test/kotlin/AppTest.kt", "data/src/main/kotlin/Data.kt", "data/src/test/kotlin/DataTest.kt",
  ];
  const suite = ["core/src/test/kotlin/CartTest.kt", "app/src/test/kotlin/AppTest.kt", "data/src/test/kotlin/DataTest.kt"];
  const settings = ["settings.gradle.kts", "include(\":core\", \":app\", \":data\")"] as const;
  const coords = Array.from({ length: 150 }, (_, k) => `  implementation("com.example:lib${k}:1.0.${k}")`).join("\n");
  for (const body of [
    "dependencies {\n  implementation(project(\":core\").also { println(it) })\n}",
    "dependencies {\n  api(project(\":core\").apply { version = \"1\" })\n}",
    "dependencies {\n  testImplementation(project(\":core\").extensions.getByType<SourceSetContainer>()[\"test\"].output)\n}",
    "dependencies {\n  testImplementation(files(project(\":core\").tasks.named(\"testJar\")))\n  implementation(project(\":data\"))\n}",
    "dependencies {\n  implementation(\"x:y:1\") { exclude(group = \"z\") }\n  findProject(\":core\")?.let { implementation(it) }\n}",
    "dependencies {\n  implementation(\"x:y:${libVersion}\")\n  findProject(\":core\")?.let { implementation(it) }\n}",
    `dependencies {\n${coords}\n  findProject(":core")?.let { implementation(it) }\n}`,
    "findProject(\":core\")?.let {\n  dependencies {\n    implementation(it)\n  }\n}",
    "dependencies {\n  implementation(\"x:y:1\") { because(\"fixes } in a string\") }\n  findProject(\":core\")?.let { implementation(it) }\n}",
  ]) {
    const files = new Map<string, string>([settings, ["app/build.gradle.kts", body]]);
    const result = computeAffectedTests({ changedFiles: ["core/src/main/kotlin/Cart.kt"], moduleGraph: { allFiles, fileContents: files }, fullSuiteTests: suite });
    assert.ok(result.tests.includes("app/src/test/kotlin/AppTest.kt"), body.slice(0, 120));
  }
  // Precise controls: same-module nested dependency blocks and plain edges.
  for (const body of [
    "kotlin {\n  sourceSets {\n    commonMain {\n      dependencies {\n        implementation(project(\":core\"))\n      }\n    }\n  }\n}",
    "dependencies {\n  implementation(project(\":core\")) { exclude(group = \"x\") }\n  implementation(findProject(\":core\")!!)\n  implementation(\"x:y:${v}\")\n}",
    "dependencies {\n  implementation project(path: ':core', configuration: 'default')\n  implementation project(':core') { transitive = false }\n}",
  ]) {
    const files = new Map<string, string>([settings, ["app/build.gradle.kts", body]]);
    assert.equal(parseMavenGradleGraph(files)?.edgesUnknown, undefined, body.slice(0, 120));
    const data = computeAffectedTests({ changedFiles: ["data/src/main/kotlin/Data.kt"], moduleGraph: { allFiles, fileContents: files }, fullSuiteTests: suite });
    assert.deepEqual(data.tests, ["data/src/test/kotlin/DataTest.kt"], body.slice(0, 120));
    const core = computeAffectedTests({ changedFiles: ["core/src/main/kotlin/Cart.kt"], moduleGraph: { allFiles, fileContents: files }, fullSuiteTests: suite });
    assert.deepEqual(core.tests, ["app/src/test/kotlin/AppTest.kt", "core/src/test/kotlin/CartTest.kt"], body.slice(0, 120));
  }
});

test("R10: statement-level openers, escaping project values, build logic and project() self", () => {
  const allFiles = [
    "core/src/main/kotlin/Cart.kt", "core/src/test/kotlin/CartTest.kt",
    "app/src/test/kotlin/AppTest.kt", "data/src/main/kotlin/Data.kt", "data/src/test/kotlin/DataTest.kt",
  ];
  const suite = ["core/src/test/kotlin/CartTest.kt", "app/src/test/kotlin/AppTest.kt", "data/src/test/kotlin/DataTest.kt"];
  const settings = ["settings.gradle", "include ':core', ':app', ':data'"] as const;
  const selects = (files: Map<string, string>, changed: string) =>
    computeAffectedTests({ changedFiles: [changed], moduleGraph: { allFiles, fileContents: files }, fullSuiteTests: suite }).tests;

  // B1: a module's own Allman-style `dependencies\n{` keeps its edge (precise).
  for (const body of ["dependencies\n{\n  implementation project(':core')\n}", "dependencies\r\n{\r\n  implementation(project(\":core\"))\r\n}"]) {
    const files = new Map<string, string>([settings, ["app/build.gradle", body]]);
    assert.equal(parseMavenGradleGraph(files)?.edgesUnknown, undefined, body);
    assert.deepEqual(selects(files, "core/src/main/kotlin/Cart.kt"), ["app/src/test/kotlin/AppTest.kt", "core/src/test/kotlin/CartTest.kt"], body);
    assert.deepEqual(selects(files, "data/src/main/kotlin/Data.kt"), ["data/src/test/kotlin/DataTest.kt"], body);
  }
  // B1: next-line and wrapped cross-project openers fail closed.
  for (const root of [
    "subprojects\n{\n  dependencies {\n    implementation project(':core')\n  }\n}",
    "configure(\n  subprojects.filter { it.name != \"core\" }\n) {\n  dependencies {\n    implementation(project(\":core\"))\n  }\n}",
  ]) {
    const files = new Map<string, string>([settings, ["build.gradle", root]]);
    assert.equal(parseMavenGradleGraph(files)?.edgesUnknown, true, root);
  }
  // B2: project values that escape outside a dependencies block fail closed.
  for (const body of [
    "val coreProject = project(\":core\")\ndependencies {\n  implementation(coreProject)\n}",
    "def shared = [project(':core')]\ndependencies {\n  shared.each { implementation it }\n}",
    "fun DependencyHandler.shared() { add(\"implementation\", project(\":core\")) }\ndependencies { shared() }",
    "ext.coreDep = project(':core')",
  ]) {
    const files = new Map<string, string>([settings, ["app/build.gradle", body]]);
    assert.equal(parseMavenGradleGraph(files)?.edgesUnknown, true, body);
    assert.ok(selects(files, "core/src/main/kotlin/Cart.kt").includes("app/src/test/kotlin/AppTest.kt"), body);
  }
  // B2 controls: on-the-spot uses stay benign.
  for (const root of [
    "tasks.register(\"ci\") {\n  dependsOn(project(\":app\").tasks.named(\"check\"))\n}",
    "findProject(\":app\")?.let { it.version = \"1.0\" }",
    "project(':core') {\n  apply plugin: 'java'\n}",
    "evaluationDependsOn(':core')",
  ]) {
    const files = new Map<string, string>([settings, ["build.gradle", root], ["app/build.gradle", "dependencies {\n  implementation project(':core')\n}"]]);
    assert.equal(parseMavenGradleGraph(files)?.edgesUnknown, undefined, root);
    assert.deepEqual(selects(files, "data/src/main/kotlin/Data.kt"), ["data/src/test/kotlin/DataTest.kt"], root);
  }
  // B3: project references in build logic outside build.gradle fail closed.
  for (const [path, content] of [
    ["build-logic/convention/src/main/kotlin/AndroidFeatureConventionPlugin.kt", "class P : Plugin<Project> { override fun apply(target: Project) { target.dependencies.add(\"implementation\", target.project(\":core\")) } }"],
    ["buildSrc/src/main/kotlin/feature.gradle.kts", "dependencies { implementation(project(\":core\")) }"],
    ["gradle/shared-deps.gradle", "dependencies { implementation project(':core') }"],
  ] as const) {
    const files = new Map<string, string>([settings, [path, content], ["app/build.gradle", "apply from: rootProject.file('gradle/shared-deps.gradle')"]]);
    assert.equal(parseMavenGradleGraph(files)?.edgesUnknown, true, path);
  }
  // B3 control: build logic with no project references stays precise.
  const cleanLogic = new Map<string, string>([
    settings,
    ["buildSrc/src/main/kotlin/java-conventions.gradle.kts", "plugins { java }\ndependencies { testImplementation(\"junit:junit:4.13\") }"],
    ["app/build.gradle", "dependencies {\n  implementation project(':core')\n}"],
  ]);
  assert.equal(parseMavenGradleGraph(cleanLogic)?.edgesUnknown, undefined);
  // B4: `project()` with no path is the current project: no edge, precise.
  const self = new Map<string, string>([settings, ["data/build.gradle.kts", "testing {\n  suites {\n    val integrationTest by registering(JvmTestSuite::class) {\n      dependencies {\n        implementation(project())\n      }\n    }\n  }\n}"]]);
  assert.equal(parseMavenGradleGraph(self)?.edgesUnknown, undefined);
  assert.deepEqual(selects(self, "core/src/main/kotlin/Cart.kt"), ["core/src/test/kotlin/CartTest.kt"]);
});

test("R11: long cross-project openers fail closed; configure lists and Allman project blocks stay precise", () => {
  const settings = ["settings.gradle", "include ':core', ':app', ':data', ':bom', ':docs'"] as const;
  const names = Array.from({ length: 40 }, (_, k) => `'excluded-module-${k}'`).join(", ");
  for (const root of [
    `configure(subprojects.findAll { ![${names}].contains(it.name) }) { dependencies { implementation project(':core') } }`,
    `configure(subprojects.filter { it.path in listOf(${names.replaceAll("'", "\"")}) }) {\n  dependencies {\n    implementation(project(":core"))\n  }\n}`,
  ]) {
    assert.equal(parseMavenGradleGraph(new Map([settings, ["build.gradle", root]]))?.edgesUnknown, true, root.slice(0, 60));
  }
  for (const root of [
    "configure(listOf(project(\":app\"), project(\":data\"))) {\n  apply(plugin = \"java\")\n}",
    "configure([project(':app'), project(':data')]) {\n  apply plugin: 'java'\n}",
    "project(':app')\n{\n  apply plugin: 'java'\n}",
  ]) {
    const files = new Map<string, string>([settings, ["build.gradle", root], ["app/build.gradle", "dependencies {\n  implementation project(':core')\n}"]]);
    assert.equal(parseMavenGradleGraph(files)?.edgesUnknown, undefined, root);
  }
});
