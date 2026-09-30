import { createWorkBenchCaseHash } from "../case-loader";
import type { WorkBenchCaseOption, WorkBenchCasePackOption } from "../corpus";
import type { WorkBenchCase } from "../types";
import {
  RECOVERABLE_JOB_SERVICE_CASE_ID,
  RECOVERABLE_JOB_SERVICE_CONTRACT_VERSION,
  RECOVERABLE_JOB_SERVICE_EDITABLE_FILES,
  RECOVERABLE_JOB_SERVICE_HIDDEN_FILES,
  RECOVERABLE_JOB_SERVICE_INPUT_HASHES,
  RECOVERABLE_JOB_SERVICE_PACK_ID,
  RECOVERABLE_JOB_SERVICE_PROFILE,
  RECOVERABLE_JOB_SERVICE_PROTECTED_FILES,
  RECOVERABLE_JOB_SERVICE_PUBLIC_COMMAND,
  RECOVERABLE_JOB_SERVICE_PUBLIC_COMMANDS,
  RECOVERABLE_JOB_SERVICE_SUITE_VERSION,
  createRecoverableJobServiceFixture,
} from "./fixture";

export function createRecoverableJobServiceCase(): WorkBenchCase {
  return {
    schemaVersion: 1,
    id: RECOVERABLE_JOB_SERVICE_CASE_ID,
    title: "Recoverable Job Service",
    description:
      "Implement the published modeled Recoverable Job Service contract in one isolated ES2022 source file. The trusted evaluator applies binary scoring across every mandatory family and variant.",
    difficulty: "expert",
    tags: ["workbench", "javascript", "multi-file-contract", "recoverability"],
    caseVersion: RECOVERABLE_JOB_SERVICE_SUITE_VERSION,
    prompt: {
      userRequest: [
        "Implement the Recoverable Job Service described by the normative `problem.md`, `acceptance-contract.md`, `runtime-contract.md`, `contract.d.ts`, and `source-bootstrap.md` files supplied in this fixture.",
        "The starter is `service.js`; the only editable file is `service.js`. Keep the required `globalThis.createService` interface and plain ES2022 script form.",
        "Use `families.json` and `source-variants.json` to understand the published coverage. `examples.mjs` and `source-examples.mjs` are illustrative and do not exhaust all legal mandatory schedules.",
        `Run \`${RECOVERABLE_JOB_SERVICE_PUBLIC_COMMAND}\` for all public examples, or append a published family/recipe ID for one public check. The final trusted \`node verify.mjs\` command runs only after build handoff.`,
        "Scoring is binary: every mandatory family and variant must pass with measured safety evidence. Candidate failures score zero; invalid trusted infrastructure is excluded.",
      ].join("\n\n"),
      publicContext: [
        `Contract ${RECOVERABLE_JOB_SERVICE_CONTRACT_VERSION}; suite ${RECOVERABLE_JOB_SERVICE_SUITE_VERSION}.`,
        `Profile ${RECOVERABLE_JOB_SERVICE_PROFILE}.`,
        "Modeled process, storage, output, recovery, ownership, and cleanup behavior runs in a bounded QuickJS guest under Node.js 24.18.0 and quickjs-emscripten 0.32.0.",
        "Equal model budget: 3,600 seconds, 120 model calls, 500 tool calls, 3,000,000 input tokens, and 200,000 output tokens.",
      ].join("\n"),
      hiddenNotesHash: RECOVERABLE_JOB_SERVICE_INPUT_HASHES.suiteHash,
    },
    repo: {
      url: "fixture://inline",
      baseCommit: "recoverable-job-service-v2-public-fixture",
      shallowClone: true,
      fixtureHash: `rjs:${RECOVERABLE_JOB_SERVICE_INPUT_HASHES.contractHash}:${RECOVERABLE_JOB_SERVICE_INPUT_HASHES.suiteHash}`,
    },
    environment: {
      type: "local-runner",
      timeoutSeconds: 3_600,
      network: "dependency-only",
    },
    verifier: {
      command: "node verify.mjs",
      resultFile: "verifier-result.json",
      publicCommand: RECOVERABLE_JOB_SERVICE_PUBLIC_COMMAND,
      timeoutSeconds: 660,
    },
    budget: {
      maxWallClockSeconds: 3_600,
      maxModelCalls: 120,
      maxToolCalls: 500,
      maxInputTokens: 3_000_000,
      maxOutputTokens: 200_000,
    },
    scoring: { scoringVersion: "recoverable-job-service-binary-v2" },
    contamination: {
      originalTask: true,
      canary: "AIBENCH-RJS-V2-PUBLIC-CONTRACT",
      referenceSolutionPrivate: true,
      publicAfter: "2027-09-12",
    },
    allowedCommands: [...RECOVERABLE_JOB_SERVICE_PUBLIC_COMMANDS],
    fixtureFiles: createRecoverableJobServiceFixture(),
    trustedPolicy: {
      kind: "recoverable-job-service",
      runtimeModule: "benchmarks/recoverable-job-service/private/runtime.mjs",
      requiredNodeVersion: "24.18.0",
      requiredQuickJsVersion: "0.32.0",
      contractHash: RECOVERABLE_JOB_SERVICE_INPUT_HASHES.contractHash,
      suiteHash: RECOVERABLE_JOB_SERVICE_INPUT_HASHES.suiteHash,
      hiddenPaths: [...RECOVERABLE_JOB_SERVICE_HIDDEN_FILES],
      protectedPaths: [...RECOVERABLE_JOB_SERVICE_PROTECTED_FILES],
      editablePaths: [...RECOVERABLE_JOB_SERVICE_EDITABLE_FILES],
    },
  };
}

export function createRecoverableJobServiceCaseOption(): WorkBenchCaseOption {
  const workBenchCase = createRecoverableJobServiceCase();
  return {
    id: workBenchCase.id,
    label: "Recoverable Job Service (JavaScript)",
    fixtureLanguage: "javascript",
    challengeKind: "multi-file-contract",
    caseHash: createWorkBenchCaseHash(workBenchCase),
    referenceSolutionNotes: "The private reference is not part of the candidate task.",
    negativeControlWrongSolution: "Candidate failures are determined only by the trusted verifier.",
    case: workBenchCase,
  };
}

export function createRecoverableJobServiceCasePack(): WorkBenchCasePackOption {
  const rjsCase = createRecoverableJobServiceCaseOption();
  return {
    id: RECOVERABLE_JOB_SERVICE_PACK_ID,
    label: "Recoverable Job Service",
    description: "Runs the standalone modeled Recoverable Job Service benchmark with binary scoring.",
    caseCount: 1,
    caseIds: [rjsCase.id],
    cases: [rjsCase],
  };
}
