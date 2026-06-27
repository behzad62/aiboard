/* Certified benchmark artifact checks (run: npx tsx scripts/test-benchmark-artifacts.mts) */
import {
  capArtifactContent,
  createJsonArtifact,
  createLogArtifact,
  createMarkdownArtifact,
  createPatchArtifact,
  hashArtifactContent,
} from "../lib/benchmark/artifacts";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const json = createJsonArtifact({
  id: "json-1",
  label: "Verifier result",
  content: { passed: true, score: 1 },
  createdAt: "2026-06-27T10:00:00.000Z",
});
check("json artifact serializes content", json.kind === "json" && json.mimeType === "application/json" && json.content.includes("\"passed\": true"), json);

const markdown = createMarkdownArtifact({ id: "md-1", label: "Summary", content: "# Summary" });
check("markdown artifact uses markdown mime", markdown.mimeType === "text/markdown", markdown);

const patch = createPatchArtifact({ id: "patch-1", label: "Patch", content: "diff --git a/a b/a" });
check("patch artifact uses patch kind", patch.kind === "patch" && patch.mimeType === "text/x-patch", patch);

const capped = capArtifactContent("x".repeat(200), 50);
check("oversized logs capped", capped.length <= 80 && capped.includes("truncated"), capped);

const log = createLogArtifact({ id: "log-1", label: "Verifier log", content: "x".repeat(200), maxChars: 50 });
check("log helper caps content", log.content.length <= 80, log.content);

const hashA = hashArtifactContent(json.content);
const hashB = hashArtifactContent(JSON.parse(JSON.stringify(json)).content);
check("artifact hash stable after import/export", hashA === hashB && hashA.length > 0, { hashA, hashB });

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
