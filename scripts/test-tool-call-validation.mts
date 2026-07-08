/** Strict Build tool-call validation checks (run: npx tsx scripts/test-tool-call-validation.mts) */
import {
  hasCompleteBuildToolAction,
  inspectStrictToolActionBatchOutput,
  inspectStrictToolActionOutput,
} from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const clean = inspectStrictToolActionOutput(
  '{"action":"read_range","path":"src/cli.ts","startLine":10,"lineCount":40}'
);
check("bare single tool action is accepted", clean.valid && clean.action?.action === "read_range", clean);

const fenced = inspectStrictToolActionOutput(
  '```json\n{"action":"search","query":"normalizePath"}\n```'
);
check("single fenced tool action is accepted", fenced.valid && fenced.action?.action === "search", fenced);

const shellAlias = inspectStrictToolActionOutput(
  '{"action":"shell","cmd":"npm test","reason":"verify"}'
);
check(
  "shell tool alias is normalized to run",
  shellAlias.valid &&
    shellAlias.action?.action === "run" &&
    shellAlias.action.command === "npm test",
  shellAlias
);

const repoInit = inspectStrictToolActionOutput(
  '{"action":"repo_init","branch":"main","reason":"user asked for a local repo"}'
);
check(
  "repo_init tool action is accepted",
  repoInit.valid &&
    repoInit.action?.action === "repo_init" &&
    repoInit.action.branch === "main",
  repoInit
);

const badRepoInit = inspectStrictToolActionOutput(
  '{"action":"repo_init","branch":"bad branch with spaces"}'
);
check(
  "repo_init rejects malformed branch names",
  !badRepoInit.valid && badRepoInit.action === null,
  badRepoInit
);

const chatty = inspectStrictToolActionOutput(
  'Let me patch that.\n{"action":"patch","path":"src/cli.ts","ops":[{"search":"old","replace":"new"}]}'
);
check("prose plus one tool action is salvageable", chatty.valid && chatty.action?.action === "patch", chatty);
check("salvaged chatty tool action gets warning feedback", /only/i.test(chatty.feedback ?? ""), chatty);

const multipleSafe = inspectStrictToolActionBatchOutput(
  [
    '{"action":"read_range","path":"tests/run-tests.ts","startLine":1,"lineCount":100}',
    '{"action":"read_range","path":"tests/run-tests.ts","startLine":100,"lineCount":100}',
    '{"action":"search","query":"coerceValue"}',
  ].join("\n\n")
);
check("multiple safe tool actions parse as a valid batch", multipleSafe.valid && multipleSafe.actions.length === 3, multipleSafe);
check("batch parse includes scheduling feedback", /batch/i.test(multipleSafe.feedback ?? ""), multipleSafe);

const malformedPartialBatch = inspectStrictToolActionBatchOutput(
  '{"action":"search","query":"createWindowWallMesh"},{"'
);
check(
  "partial multi-action JSON fragment is rejected as malformed",
  malformedPartialBatch.actions.length === 0 &&
    malformedPartialBatch.valid === false &&
    /incomplete|truncated|malformed|valid JSON|cut off/i.test(
      malformedPartialBatch.feedback ?? ""
    ),
  malformedPartialBatch
);

const readThenPatch = inspectStrictToolActionOutput(
  [
    '{"action":"read_range","path":"tests/run-tests.ts","startLine":220,"lineCount":140}',
    "</think>",
    '{"action":"patch","path":"tests/run-tests.ts","ops":[{"search":"old","replace":"new"}]}',
  ].join("\n\n")
);
check(
  "read then patch executes read and ignores patch",
  readThenPatch.valid &&
    readThenPatch.action?.action === "read_range" &&
    /ignored/i.test(readThenPatch.feedback ?? ""),
  readThenPatch
);

const patchThenRead = inspectStrictToolActionOutput(
  [
    '{"action":"patch","path":"tests/run-tests.ts","ops":[{"search":"old","replace":"new"}]}',
    '{"action":"read_range","path":"tests/run-tests.ts","startLine":1,"lineCount":50}',
  ].join("\n\n")
);
check("multiple tool actions with write first are rejected", !patchThenRead.valid && /multiple/i.test(patchThenRead.feedback ?? ""), patchThenRead);

const finalText = inspectStrictToolActionOutput("I made the changes in the files below.");
check("plain final prose has no tool action", finalText.action === null && finalText.valid === false, finalText);

const truncatedPatch = inspectStrictToolActionOutput(
  '{"action":"patch","path":"tests/run-tests.ts","ops":[{"search":"old block","replace":"new block'
);
check(
  "truncated patch JSON is rejected with corrective feedback",
  truncatedPatch.action === null &&
    truncatedPatch.valid === false &&
    /incomplete|truncated|cut off/i.test(truncatedPatch.feedback ?? ""),
  truncatedPatch
);

check(
  "incomplete streamed tool JSON does not trigger early stop",
  !hasCompleteBuildToolAction('{"action":"read_range","path":"src/cli.ts","startLine":1'),
);
check(
  "complete streamed tool JSON triggers early stop",
  hasCompleteBuildToolAction('Let me inspect.\n{"action":"read_range","path":"src/cli.ts","startLine":1,"lineCount":80}'),
);
check(
  "plan JSON does not trigger tool early stop",
  !hasCompleteBuildToolAction('{"action":"plan","tasks":[{"title":"T","instructions":"I"}]}'),
);

process.exit(failed === 0 ? 0 : 1);
