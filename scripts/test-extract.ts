/* Quick extractor regression checks (run: npx tsx scripts/test-extract.ts) */
import { readFileSync } from "node:fs";
import { extractArtifacts } from "../lib/artifacts/extract";

const FENCE = "```";
let failures = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`, ok ? "" : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

// 1. Bare `path=` line inside the fence (gemma's format) — line stripped.
const t1 = extractArtifacts(
  `intro\n${FENCE}html\npath=index.html\n<!DOCTYPE html>\n<title>x</title>\n${FENCE}\ndone`
);
check("bare-attr path", t1.files.map((f) => f.path), ["index.html"]);
check("bare-attr stripped", t1.files[0]?.content.startsWith("<!DOCTYPE html>"), true);

// 2. Info-line attribute (the canonical format).
const t2 = extractArtifacts(`${FENCE}ts path=src/a.ts\nconst a=1;\n${FENCE}`);
check("info-attr path", t2.files.map((f) => f.path), ["src/a.ts"]);

// 3. Comment first line keeps the comment in content.
const t3 = extractArtifacts(`${FENCE}js\n// path: lib/b.js\nlet b;\n${FENCE}`);
check("comment path", t3.files.map((f) => f.path), ["lib/b.js"]);
check("comment kept", t3.files[0]?.content.includes("// path: lib/b.js"), true);

// 4. A code block without any path stays prose.
const t4 = extractArtifacts(`${FENCE}\nconst nothing = true;\n${FENCE}`);
check("non-file stays prose", t4.files.length, 0);

// 5. A bare line that is not a real path is not treated as one.
const t5 = extractArtifacts(`${FENCE}\npath = not a path line really\ncode\n${FENCE}`);
check("bogus bare attr ignored", t5.files.length, 0);

// 6. A file block whose closing fence never arrived (stream cut off) is
// rejected — never written as a half file — and reported as truncated.
const t6 = extractArtifacts(
  `Here is the complete corrected file:\n${FENCE}ts path=lib/x.ts\nexport function a() {}\n/**\n * Case`
);
check("truncated file rejected", t6.files.length, 0);
check("truncated file reported", t6.truncatedPaths, ["lib/x.ts"]);

// 7. Closed blocks before a truncated one still extract normally.
const t7 = extractArtifacts(
  `${FENCE}ts path=src/ok.ts\nconst ok = 1;\n${FENCE}\n${FENCE}ts path=src/cut.ts\nconst cut =`
);
check("closed file kept", t7.files.map((f) => f.path), ["src/ok.ts"]);
check("only cut one reported", t7.truncatedPaths, ["src/cut.ts"]);

// 8. An edit op whose REPLACE terminator never arrived is dropped; prior
// terminated ops in the same block survive, and the block is flagged.
const t8 = extractArtifacts(
  `${FENCE}edit path=src/e.ts\n<<<<<<< SEARCH\nold1\n=======\nnew1\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nold2\n=======\nnew2 but the stream died`
);
check("terminated op kept", t8.edits[0]?.ops.length, 1);
check("terminated op content", t8.edits[0]?.ops[0]?.replace, "new1");
check("truncated edit flagged", t8.truncatedPaths, ["src/e.ts"]);

// 9. Well-formed output reports no truncation.
check("no truncation on clean output", t2.truncatedPaths, []);

// ── Architect action parsing (build protocol) ────────────────────────────────
import { parseArchitectAction } from "../lib/orchestrator/build";

const a1 = parseArchitectAction(
  'Let me verify.\n```json\n{"action":"run","command":"npm test","reason":"check"}\n```'
);
check("parse run action", a1 && a1.action === "run" && (a1 as { command: string }).command, "npm test");

const a2 = parseArchitectAction('{"action":"run","command":"   "}');
check("reject empty run command", a2, null);

const a3 = parseArchitectAction(
  'prose\n```json\n{"action":"plan","tasks":[{"title":"x","instructions":"y"}]}\n```'
);
check("parse plan action", a3 && a3.action, "plan");

const a4 = parseArchitectAction(
  '{"action":"review","results":[{"taskId":"T1","verdict":"approve"}],"done":true}'
);
check("parse review action", a4 && a4.action === "review" && (a4 as { done: boolean }).done, true);

const a5 = parseArchitectAction("no json here at all");
check("no action -> null", a5, null);

const a6 = parseArchitectAction(
  '```json\n{"action":"fetch","url":"https://example.com/docs","reason":"read the API"}\n```'
);
check("parse fetch action", a6 && a6.action === "fetch" && (a6 as { url: string }).url, "https://example.com/docs");

const a7 = parseArchitectAction('{"action":"fetch","url":"file:///etc/passwd"}');
check("reject non-http fetch", a7, null);

// ── Language-agnostic verify-command detection ────────────────────────────────
import {
  classifyVerifyCommandForProject,
  detectVerifyCommand,
  resolveRunnerProjectTree,
} from "../lib/orchestrator/build";

check("detect dotnet", detectVerifyCommand(["App.csproj", "Program.cs"]), "dotnet build");
check(
  "nested dotnet project does not imply root dotnet build",
  detectVerifyCommand(["index.html", "src/main.js", "samples/App.csproj"]),
  ""
);
check("detect go", detectVerifyCommand(["go.mod", "main.go"]), "go build ./...");
check(
  "nested go module does not imply root go build",
  detectVerifyCommand(["index.html", "src/main.js", "samples/go.mod"]),
  ""
);
check("detect cargo", detectVerifyCommand(["Cargo.toml", "src/main.rs"]), "cargo check");
check(
  "nested cargo manifest does not imply root cargo check",
  detectVerifyCommand(["index.html", "src/main.js", "samples/Cargo.toml"]),
  ""
);
check("detect maven", detectVerifyCommand(["pom.xml", "src/Main.java"]), "mvn -q -DskipTests compile");
check("detect tsc", detectVerifyCommand(["tsconfig.json", "src/index.ts"]), "npx --yes tsc --noEmit");
check("compiled wins over tsc", detectVerifyCommand(["tsconfig.json", "api.csproj"]), "dotnet build");
check("detect cmake", detectVerifyCommand(["CMakeLists.txt", "src/main.cpp"]), "cmake -S . -B .verify-build && cmake --build .verify-build");
check("detect make", detectVerifyCommand(["Makefile", "src/main.c"]), "make");
check("cmake wins over make", detectVerifyCommand(["CMakeLists.txt", "Makefile"]), "cmake -S . -B .verify-build && cmake --build .verify-build");
check("detect mix", detectVerifyCommand(["mix.exs", "lib/app.ex"]), "mix compile");
check("detect python", detectVerifyCommand(["main.py", "utils.py"]), "python -m compileall -q .");
check(
  "nested python file does not imply root python compileall",
  detectVerifyCommand(["index.html", "src/main.js", "tools/check.py"]),
  ""
);
check("tsc wins over python", detectVerifyCommand(["tsconfig.json", "scripts/tool.py"]), "npx --yes tsc --noEmit");
check("php -> none (per-file lint)", detectVerifyCommand(["composer.json", "src/index.php"]), "");
check("bare package.json -> none", detectVerifyCommand(["package.json", "index.js"]), "");
check("plain files -> none", detectVerifyCommand(["index.html", "style.css"]), "");
const runnerScopedStaticTree = resolveRunnerProjectTree({
  browserTree: ["Parent.csproj", "sibling/index.html"],
  runnerTree: ["index.html", "src/main.js"],
});
check("runner tree replaces browser parent tree", runnerScopedStaticTree, ["index.html", "src/main.js"]);
check(
  "runner-scoped verifier ignores parent manifests",
  detectVerifyCommand(runnerScopedStaticTree),
  ""
);
const buildEngineSource = readFileSync(
  new URL("../lib/client/build-engine.ts", import.meta.url),
  "utf8"
);
check(
  "runner command refresh does not merge stale parent tree",
  buildEngineSource.includes("browserTree: diskTree") &&
    !buildEngineSource.includes("diskTree = [...new Set([...diskTree, ...refreshed])]"),
  true
);

const staticWebDotnet = classifyVerifyCommandForProject(
  "dotnet build",
  ["index.html", "src/main.js", "src/styles.css"],
  "win32"
);
check("reject dotnet verifier for static web app", staticWebDotnet.allowed, false);
check("dotnet rejection names missing project file", /csproj|sln/i.test(staticWebDotnet.reason ?? ""), true);
check(
  "allow dotnet verifier when project file exists",
  classifyVerifyCommandForProject("dotnet build", ["App.csproj"], "win32").allowed,
  true
);
check(
  "reject root dotnet verifier when only nested project file exists",
  classifyVerifyCommandForProject("dotnet build", ["index.html", "samples/App.csproj"], "win32").allowed,
  false
);
check(
  "reject root cargo verifier when only nested manifest exists",
  classifyVerifyCommandForProject("cargo check", ["index.html", "samples/Cargo.toml"], "win32").allowed,
  false
);
check(
  "reject root go verifier when only nested module exists",
  classifyVerifyCommandForProject("go build ./...", ["index.html", "samples/go.mod"], "win32").allowed,
  false
);
check(
  "reject root tsc verifier when only nested tsconfig exists",
  classifyVerifyCommandForProject("npx --yes tsc --noEmit", ["index.html", "samples/tsconfig.json"], "win32").allowed,
  false
);
check(
  "reject root npm verifier when only nested package manifest exists",
  classifyVerifyCommandForProject("npm run build", ["index.html", "samples/package.json"], "win32").allowed,
  false
);
check(
  "preserve Windows POSIX verifier rejection",
  /POSIX command "test"/.test(
    classifyVerifyCommandForProject("test -f index.html", ["index.html"], "win32").reason ?? ""
  ),
  true
);
check(
  "allow static web node existence verifier",
  classifyVerifyCommandForProject(
    'node -e "const fs=require(\'fs\'); if (!fs.existsSync(\'index.html\')) process.exit(1)"',
    ["index.html", "src/main.js"],
    "win32"
  ).allowed,
  true
);
check(
  "allow npm verifier when package manifest is planned or present",
  classifyVerifyCommandForProject("npm run build", ["package.json", "src/main.js"], "win32").allowed,
  true
);
check(
  "reject npm verifier without package manifest",
  classifyVerifyCommandForProject("npm run build", ["index.html", "src/main.js"], "win32").allowed,
  false
);

process.exit(failures === 0 ? 0 : 1);
