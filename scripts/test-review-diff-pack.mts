/**
 * Diff-first review evidence checks
 * (run: npx tsx scripts/test-review-diff-pack.mts)
 *
 * Covers buildReviewDiffPackContent (bounded diff pack rendering) and the
 * buildArchitectReviewPrompt hasDiffDigest instruction line.
 */
import {
  buildReviewDiffPackContent,
  buildArchitectReviewPrompt,
} from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const TRUNCATION_MARKER = "\n...[diff truncated - use read_range for the rest]";

// 1. Empty stat + patch -> "".
check(
  "empty stat and patch renders nothing",
  buildReviewDiffPackContent({ stat: "", patch: "", files: ["a.ts"], maxChars: 24_000 }) === "",
);

// 2. Whitespace-only stat + patch is treated as absent.
check(
  "whitespace-only stat and patch renders nothing",
  buildReviewDiffPackContent({ stat: "   \n ", patch: "\n\t  ", files: ["a.ts"], maxChars: 24_000 }) === "",
);

// 3. Stat-only renders header + files + Stat, but no Patch section.
{
  const out = buildReviewDiffPackContent({
    stat: " a.ts | 2 +-\n 1 file changed",
    patch: "",
    files: ["a.ts", "b.ts"],
    maxChars: 24_000,
  });
  check(
    "stat-only renders header",
    out.includes("Unified diff of this wave's landed changes (primary review evidence):"),
    out
  );
  check("stat-only lists files", out.includes("a.ts, b.ts"), out);
  check("stat-only includes Stat block", /Stat:/.test(out) && out.includes("1 file changed"), out);
  check("stat-only omits Patch section", !/Patch:/.test(out), out);
}

// 4. Small patch renders fully (no truncation marker).
{
  const patch = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new";
  const out = buildReviewDiffPackContent({
    stat: " a.ts | 2 +-",
    patch,
    files: ["a.ts"],
    maxChars: 24_000,
  });
  check("small patch renders the Patch section", /Patch:/.test(out), out);
  check("small patch includes the full patch text", out.includes(patch), out);
  check("small patch has no truncation marker", !out.includes(TRUNCATION_MARKER), out);
}

// 5. Oversized patch is truncated: total length <= maxChars + marker length, ends with marker.
{
  const maxChars = 1_000;
  const patch = "+".repeat(5_000);
  const out = buildReviewDiffPackContent({
    stat: " a.ts | 5000 +",
    patch,
    files: ["a.ts"],
    maxChars,
  });
  check("oversized patch renders a Patch section", /Patch:/.test(out), out.length);
  check(
    "oversized patch total length within maxChars + marker",
    out.length <= maxChars + TRUNCATION_MARKER.length,
    out.length
  );
  check("oversized patch ends with the truncation marker", out.endsWith(TRUNCATION_MARKER), out.slice(-80));
}

// 6. Files list caps at 40 with a (+N more) suffix.
{
  const files = Array.from({ length: 47 }, (_, i) => `file-${i}.ts`);
  const out = buildReviewDiffPackContent({
    stat: "47 files changed",
    patch: "",
    files,
    maxChars: 24_000,
  });
  check("files list caps at 40 entries", out.includes("file-39.ts") && !out.includes("file-40.ts"), out);
  check("files list shows the (+N more) overflow suffix", out.includes("(+7 more)"), out);
}

// 7. Tiny maxChars leaves prefix-only output (no Patch section) when stat present.
{
  const out = buildReviewDiffPackContent({
    stat: " a.ts | 2 +-\n 1 file changed",
    patch: "+".repeat(2_000),
    files: ["a.ts"],
    // Just enough for the header/files/stat prefix, nowhere near enough for any patch char.
    maxChars: 90,
  });
  check("tiny maxChars still returns the stat prefix", out.includes("Stat:") && out.includes("a.ts"), out);
  check("tiny maxChars omits the Patch section entirely", !/Patch:/.test(out), out);
  check("tiny maxChars emits no truncation marker (no patch shown)", !out.includes(TRUNCATION_MARKER), out);
}

// 8. Review prompt gains the diff-first instruction line only when hasDiffDigest is true.
{
  const base = {
    request: "Create a web app for exploring a local git repository.",
    treeText: "public/app.js\nserver/server.js",
    executedText: "T1 landed UI and backend changes.",
    outstandingTasks: "",
    maxNewTasks: 2,
    cyclesLeft: 1,
    fileContext: "",
    readHopsLeft: 0,
    rangeReadsLeft: 0,
    runsLeft: 0,
    searchesLeft: 0,
    mcpToolsDoc: "",
    mcpCallsLeft: 0,
  } as Parameters<typeof buildArchitectReviewPrompt>[0];
  const DIFF_LINE = "PRIMARY evidence for this review";
  const withDiff = buildArchitectReviewPrompt({ ...base, hasDiffDigest: true });
  const withoutDiff = buildArchitectReviewPrompt({ ...base, hasDiffDigest: false });
  check("review prompt adds the diff-first line when hasDiffDigest is true", withDiff.includes(DIFF_LINE), withDiff);
  check(
    "review prompt omits the diff-first line when hasDiffDigest is false/absent",
    !withoutDiff.includes(DIFF_LINE),
    withoutDiff
  );
  check(
    "diff-first line sits right before the review-instruction block",
    withDiff.indexOf(DIFF_LINE) < withDiff.indexOf("Review each task's output"),
    withDiff
  );
}

process.exit(failed === 0 ? 0 : 1);
