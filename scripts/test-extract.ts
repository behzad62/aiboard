/* Quick extractor regression checks (run: npx tsx scripts/test-extract.ts) */
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

process.exit(failures === 0 ? 0 : 1);
