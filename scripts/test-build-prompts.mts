/** Build prompt regression checks (run: npx tsx scripts/test-build-prompts.mts) */
import {
  buildWorkerTaskPrompt,
  scoreboardSection,
  type BuildTask,
} from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const fixingTask: BuildTask = {
  id: "T3",
  title: "Final verification and fix strict/test failures",
  instructions:
    "Fix tests/run-tests.ts and src/query.ts. Do not modify unrelated files.",
  contextFiles: ["tests/run-tests.ts", "src/query.ts"],
  outputPaths: ["tests/run-tests.ts", "src/query.ts"],
  expectedOutputs: "targeted fixes to tests/run-tests.ts and src/query.ts",
  status: "fixing",
};

const prompt = buildWorkerTaskPrompt({
  request: "Build a strict TypeScript CSV library and CLI.",
  treeText: "tests/run-tests.ts\nsrc/query.ts",
  task: fixingTask,
  contextFileText: "\nContext files:\n--- tests/run-tests.ts ---\n<large file>",
  architectNotes: "Use strict TypeScript.",
  toolInstructions: [
    'FILE TOOLS — use {"action":"read_range"}, {"action":"patch"}, and {"action":"append"} before final output. Do not emit full-file blocks for existing files.',
    "If a returned range is partial, continue from endLine + 1 instead of rereading overlapping lines.",
    "After search results, read_range around the returned path:line matches, not from the start of the file.",
  ].join(" "),
  verbosityInstruction: "Keep prose brief.",
});

check("fix prompt includes range-read guidance", prompt.includes('"action":"read_range"'));
check("fix prompt includes patch guidance", prompt.includes('"action":"patch"'));
check("fix prompt includes append guidance for large/missing files", prompt.includes('"action":"append"'));
check("fix prompt tells workers to continue partial ranges", /endLine \+ 1/i.test(prompt), prompt);
check("fix prompt tells workers to read around search matches", /path:line matches/i.test(prompt), prompt);
check(
  "fix prompt allows scheduled JSON tool actions",
  /one or more JSON tool actions/i.test(prompt),
  prompt
);
check(
  "fix prompt forbids full existing-file rewrites",
  /do not emit full-file blocks for existing files/i.test(prompt),
  prompt
);
check(
  "fix prompt no longer says re-emit complete corrected files",
  !/Re-emit the complete corrected files/i.test(prompt),
  prompt
);
check(
  "fix prompt no longer has unconditional complete-contents rule",
  !/give the COMPLETE contents of every file you write/i.test(prompt),
  prompt
);

const scoreboard = scoreboardSection("- claude-opus-4-5: score 3\n- Gemini 3.5 Flash: score 0");
check(
  "scoreboard prompt tells Architect assignTo is a sparse preference",
  /assignTo sparingly/i.test(scoreboard) && /engine balances/i.test(scoreboard),
  scoreboard
);

process.exit(failed === 0 ? 0 : 1);
