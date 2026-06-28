import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listGameIqScenarioPacks,
  stableGameIqScenarioPackDigest,
} from "../lib/benchmark/gameiq";
import {
  TOOL_RELIABILITY_V0_1_CASES,
  validateToolReliabilityCasePack,
} from "../lib/benchmark/toolreliability";
import {
  createWorkBenchCaseHash,
  loadWorkBenchCase,
} from "../lib/benchmark/workbench/case-loader";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const benchmarksRoot = join(repoRoot, "benchmarks");

const gameFileById = new Map([
  ["connect-four", "connect-four.json"],
  ["chess", "chess.json"],
  ["battleship", "battleship.json"],
  ["codenames", "codenames.json"],
  ["fireworks", "fireworks.json"],
]);

interface WorkBenchFixtureSpec {
  id: string;
  language: "typescript" | "python" | "go" | "rust" | "react-ui";
  title: string;
  description: string;
  difficulty: "easy" | "medium" | "hard" | "expert";
  tags: string[];
  userRequest: string;
  publicContext: string;
  filePath: string;
  initialContent: string;
  referenceNotes: string;
  negativeControl: string;
  checks: Array<{ id: string; label: string; contains: string; weight?: number }>;
}

const workBenchSpecs: WorkBenchFixtureSpec[] = [
  {
    id: "workbench-v1-ts-normalize-0001",
    language: "typescript",
    title: "TypeScript string normalizer",
    description: "Normalize user-provided labels before downstream matching.",
    difficulty: "easy",
    tags: ["typescript", "utility", "string"],
    userRequest:
      "Make normalizeLabel trim surrounding whitespace and lowercase the label.",
    publicContext:
      "Existing callers expect an empty string to remain an empty string.",
    filePath: "src/normalize.ts",
    initialContent:
      "export function normalizeLabel(input: string): string {\n  return input;\n}\n",
    referenceNotes:
      "The reference solution returns input.trim().toLowerCase() from normalizeLabel without changing the function signature.",
    negativeControl:
      "A wrong solution lowercases without trimming, leaving whitespace-sensitive labels broken.",
    checks: [
      {
        id: "trim-lowercase",
        label: "Trims and lowercases labels",
        contains: "return input.trim().toLowerCase();",
      },
    ],
  },
  {
    id: "workbench-v1-ts-limit-0002",
    language: "typescript",
    title: "TypeScript bounded queue limit",
    description: "Add a fixed capacity limit to a small queue helper.",
    difficulty: "medium",
    tags: ["typescript", "data-structure", "limits"],
    userRequest:
      "Cap the queue at 50 items by dropping the oldest item when a new item is pushed past the limit.",
    publicContext: "Keep the public push and values methods unchanged.",
    filePath: "src/queue.ts",
    initialContent:
      "export class Queue<T> {\n  private readonly items: T[] = [];\n\n  push(value: T): void {\n    this.items.push(value);\n  }\n\n  values(): T[] {\n    return [...this.items];\n  }\n}\n",
    referenceNotes:
      "The reference solution defines MAX_ITEMS = 50 and shifts the oldest item after push when the array exceeds the cap.",
    negativeControl:
      "A wrong solution rejects new values after 50 items, which violates the requested drop-oldest behavior.",
    checks: [
      {
        id: "limit-constant",
        label: "Defines the 50 item limit",
        contains: "MAX_ITEMS = 50",
        weight: 0.4,
      },
      {
        id: "drop-oldest",
        label: "Drops the oldest queue item",
        contains: "this.items.shift()",
        weight: 0.6,
      },
    ],
  },
  {
    id: "workbench-v1-ts-csv-0003",
    language: "typescript",
    title: "TypeScript CSV escaping helper",
    description: "Add RFC 4180 quote escaping to a CSV utility.",
    difficulty: "medium",
    tags: ["typescript", "csv", "formatting"],
    userRequest:
      "Implement escapeCsv so values containing commas, quotes, or newlines are quoted and internal quotes are doubled.",
    publicContext: "Plain values without special characters should not be quoted.",
    filePath: "src/csv.ts",
    initialContent:
      "export function escapeCsv(value: string): string {\n  return value;\n}\n",
    referenceNotes:
      "The reference solution checks for comma, quote, CR, or LF and returns a quoted value with value.replaceAll('\"', '\"\"').",
    negativeControl:
      "A wrong solution wraps every value in quotes but does not double embedded quotes.",
    checks: [
      {
        id: "quote-doubling",
        label: "Doubles embedded quotes",
        contains: "replaceAll('\"', '\"\"')",
        weight: 0.5,
      },
      {
        id: "special-character-check",
        label: "Checks for CSV special characters",
        contains: "includes(\",\")",
        weight: 0.5,
      },
    ],
  },
  {
    id: "workbench-v1-py-slugify-0004",
    language: "python",
    title: "Python slugify helper",
    description: "Convert a display title into a lowercase URL slug.",
    difficulty: "easy",
    tags: ["python", "utility", "string"],
    userRequest:
      "Make slugify strip whitespace, lowercase the value, and replace spaces with dashes.",
    publicContext: "Do not add third-party dependencies.",
    filePath: "src/slugify.py",
    initialContent:
      "def slugify(value: str) -> str:\n    return value\n",
    referenceNotes:
      "The reference solution returns value.strip().lower().replace(\" \", \"-\") from slugify.",
    negativeControl:
      "A wrong solution replaces spaces but forgets to strip and lowercase the value.",
    checks: [
      {
        id: "slug-expression",
        label: "Strips, lowercases, and replaces spaces",
        contains: "return value.strip().lower().replace(\" \", \"-\")",
      },
    ],
  },
  {
    id: "workbench-v1-py-clamp-0005",
    language: "python",
    title: "Python numeric clamp",
    description: "Clamp a value between inclusive minimum and maximum bounds.",
    difficulty: "easy",
    tags: ["python", "math", "utility"],
    userRequest:
      "Implement clamp so values below minimum return minimum and values above maximum return maximum.",
    publicContext: "Assume minimum is less than or equal to maximum.",
    filePath: "src/clamp.py",
    initialContent:
      "def clamp(value: int, minimum: int, maximum: int) -> int:\n    return value\n",
    referenceNotes:
      "The reference solution returns max(minimum, min(maximum, value)) from clamp.",
    negativeControl:
      "A wrong solution only checks the lower bound and allows oversized values through.",
    checks: [
      {
        id: "clamp-expression",
        label: "Uses both minimum and maximum bounds",
        contains: "return max(minimum, min(maximum, value))",
      },
    ],
  },
  {
    id: "workbench-v1-go-positive-sum-0006",
    language: "go",
    title: "Go positive sum",
    description: "Sum only positive integers from a slice.",
    difficulty: "easy",
    tags: ["go", "utility", "loop"],
    userRequest: "Update SumPositive so it ignores zero and negative values.",
    publicContext: "Keep the function name and signature unchanged.",
    filePath: "sum.go",
    initialContent:
      "package bench\n\nfunc SumPositive(values []int) int {\n\ttotal := 0\n\tfor _, value := range values {\n\t\ttotal += value\n\t}\n\treturn total\n}\n",
    referenceNotes:
      "The reference solution adds an if value > 0 guard before adding to total.",
    negativeControl:
      "A wrong solution uses value >= 0, which is harmless for zero but misses the intent in review and can mask other edits.",
    checks: [
      {
        id: "positive-guard",
        label: "Adds only positive values",
        contains: "if value > 0",
      },
    ],
  },
  {
    id: "workbench-v1-go-error-return-0007",
    language: "go",
    title: "Go error propagation",
    description: "Return parser errors to callers instead of swallowing them.",
    difficulty: "medium",
    tags: ["go", "errors", "parsing"],
    userRequest:
      "Return an empty string and the parse error when parseName fails.",
    publicContext: "Do not change parseName or the LoadName signature.",
    filePath: "loader.go",
    initialContent:
      "package bench\n\nimport \"errors\"\n\nfunc parseName(raw string) (string, error) {\n\tif raw == \"\" {\n\t\treturn \"\", errors.New(\"empty\")\n\t}\n\treturn raw, nil\n}\n\nfunc LoadName(raw string) (string, error) {\n\tname, err := parseName(raw)\n\tif err != nil {\n\t\treturn \"anonymous\", nil\n\t}\n\treturn name, nil\n}\n",
    referenceNotes:
      "The reference solution changes the error branch to return \"\", err so callers can handle invalid input.",
    negativeControl:
      "A wrong solution logs the error but still returns anonymous with nil error.",
    checks: [
      {
        id: "error-propagated",
        label: "Propagates parse error",
        contains: "return \"\", err",
      },
    ],
  },
  {
    id: "workbench-v1-rs-saturating-0008",
    language: "rust",
    title: "Rust saturating increment",
    description: "Avoid overflow in a counter increment helper.",
    difficulty: "medium",
    tags: ["rust", "overflow", "utility"],
    userRequest:
      "Update increment_count to use saturating arithmetic instead of wrapping on overflow.",
    publicContext: "Keep the function signature unchanged.",
    filePath: "src/lib.rs",
    initialContent:
      "pub fn increment_count(value: u32) -> u32 {\n    value + 1\n}\n",
    referenceNotes:
      "The reference solution returns value.saturating_add(1), preserving u32::MAX at the maximum value.",
    negativeControl:
      "A wrong solution uses wrapping_add, which keeps overflow behavior instead of preventing it.",
    checks: [
      {
        id: "saturating-add",
        label: "Uses saturating addition",
        contains: "saturating_add(1)",
      },
    ],
  },
  {
    id: "workbench-v1-react-aria-0009",
    language: "react-ui",
    title: "React button accessibility label",
    description: "Add an accessible label to an icon-only save button.",
    difficulty: "easy",
    tags: ["react", "ui", "accessibility"],
    userRequest:
      "Add an accessible label so screen readers announce the save button as Save changes.",
    publicContext: "Do not add visible text to the icon-only button.",
    filePath: "src/App.tsx",
    initialContent:
      "export function App() {\n  return <button className=\"icon-button\">💾</button>;\n}\n",
    referenceNotes:
      "The reference solution adds aria-label=\"Save changes\" to the existing button without adding visible copy.",
    negativeControl:
      "A wrong solution adds a title attribute only, which is not a robust accessible name.",
    checks: [
      {
        id: "aria-label",
        label: "Adds accessible button label",
        contains: "aria-label=\"Save changes\"",
      },
    ],
  },
  {
    id: "workbench-v1-react-status-0010",
    language: "react-ui",
    title: "React loading status semantics",
    description: "Expose loading feedback with status semantics.",
    difficulty: "easy",
    tags: ["react", "ui", "accessibility"],
    userRequest:
      "Mark the loading message as a polite status region for assistive technologies.",
    publicContext: "Keep the text Loading results visible.",
    filePath: "src/App.tsx",
    initialContent:
      "export function App({ loading }: { loading: boolean }) {\n  if (loading) return <p>Loading results</p>;\n  return <p>Done</p>;\n}\n",
    referenceNotes:
      "The reference solution renders the loading paragraph with role=\"status\" and aria-live=\"polite\".",
    negativeControl:
      "A wrong solution changes only the text content, leaving no status semantics.",
    checks: [
      {
        id: "status-role",
        label: "Adds status role",
        contains: "role=\"status\"",
        weight: 0.5,
      },
      {
        id: "polite-live-region",
        label: "Adds polite live region",
        contains: "aria-live=\"polite\"",
        weight: 0.5,
      },
    ],
  },
];

await writeGameIqArtifacts();
await writeToolReliabilityArtifact();
await writeWorkBenchArtifacts();

async function writeGameIqArtifacts(): Promise<void> {
  const outputDir = join(benchmarksRoot, "gameiq", "v1");
  await mkdir(outputDir, { recursive: true });
  for (const pack of listGameIqScenarioPacks()) {
    const file = gameFileById.get(pack.gameId);
    if (!file) continue;
    await writeJson(join(outputDir, file), {
      schemaVersion: 1,
      track: "gameiq",
      packId: pack.id,
      gameId: pack.gameId,
      label: pack.label,
      version: "1.0.0",
      sourcePackVersion: pack.version,
      certificationTier: pack.certificationTier,
      scenarioCount: pack.scenarios.length,
      digest: stableGameIqScenarioPackDigest(pack),
      scenarios: pack.scenarios,
    });
  }
}

async function writeToolReliabilityArtifact(): Promise<void> {
  const outputDir = join(benchmarksRoot, "toolreliability", "v1");
  await mkdir(outputDir, { recursive: true });
  const validation = validateToolReliabilityCasePack(TOOL_RELIABILITY_V0_1_CASES);
  await writeJson(join(outputDir, "cases.json"), {
    schemaVersion: 1,
    track: "toolreliability",
    packId: "toolreliability-v1",
    version: "1.0.0",
    sourcePackVersion: "0.1.0",
    caseCount: TOOL_RELIABILITY_V0_1_CASES.length,
    validation,
    cases: TOOL_RELIABILITY_V0_1_CASES,
  });
}

async function writeWorkBenchArtifacts(): Promise<void> {
  const caseDir = join(benchmarksRoot, "workbench", "v1", "cases");
  const fixtureRoot = join(benchmarksRoot, "workbench", "v1", "fixtures");
  await mkdir(caseDir, { recursive: true });
  await mkdir(fixtureRoot, { recursive: true });

  for (const spec of workBenchSpecs) {
    const fixtureDir = join(fixtureRoot, spec.id);
    await mkdir(join(fixtureDir, dirname(spec.filePath)), { recursive: true });
    await writeFile(join(fixtureDir, spec.filePath), spec.initialContent, "utf8");
    await writeJson(join(fixtureDir, "case-meta.json"), {
      id: spec.id,
      language: spec.language,
      filePath: spec.filePath,
      checks: spec.checks,
    });
    await writeFile(join(fixtureDir, "verifier.mjs"), verifierSource(), "utf8");
    await writeFile(
      join(fixtureDir, "reference-solution.md"),
      `# Reference Solution\n\n${spec.referenceNotes}\n`,
      "utf8"
    );
    await writeJson(join(fixtureDir, "verifier-result.json"), {
      passed: true,
      score: 1,
      summary: "Reference solution satisfies all assertions.",
      assertions: spec.checks.map((check) => ({
        id: check.id,
        label: check.label,
        passed: true,
        weight: check.weight ?? 1,
      })),
    });
    await writeJson(join(fixtureDir, "negative-control.json"), {
      passed: false,
      score: 0,
      summary: spec.negativeControl,
      assertions: spec.checks.map((check) => ({
        id: check.id,
        label: check.label,
        passed: false,
        weight: check.weight ?? 1,
        message: spec.negativeControl,
      })),
    });

    const manifestBase = {
      schemaVersion: 1,
      id: spec.id,
      title: spec.title,
      description: spec.description,
      difficulty: spec.difficulty,
      tags: spec.tags,
      caseVersion: "1.0.0",
      prompt: {
        userRequest: spec.userRequest,
        publicContext: spec.publicContext,
        hiddenNotesHash: `hidden:${spec.id}`,
      },
      repo: {
        url: `fixture://${spec.id}`,
        baseCommit: "fixture-base-v1",
        shallowClone: true,
        fixtureHash: `fixture:${spec.id}`,
      },
      environment: {
        timeoutSeconds: 600,
        memoryMb: 1024,
        network: "dependency-only",
      },
      verifier: {
        command: "node verifier.mjs",
        resultFile: "verifier-result.json",
        timeoutSeconds: 60,
        publicCommand: "node verifier.mjs",
      },
      budget: {
        maxUsd: 2,
        maxWallClockSeconds: 600,
        maxModelCalls: 20,
        maxToolCalls: 100,
        maxInputTokens: 200000,
        maxOutputTokens: 50000,
      },
      scoring: {
        scoringVersion: "certified-v1",
        costTargetUsd: 1,
        timeTargetSeconds: 300,
      },
      contamination: {
        originalTask: true,
        canary: `AIBENCH-WORKBENCH-${spec.id.toUpperCase()}`,
        referenceSolutionPrivate: true,
        publicAfter: "2027-01-01",
      },
    };
    const caseHash = createWorkBenchCaseHash(loadWorkBenchCase(manifestBase));
    await writeJson(join(caseDir, `${spec.id}.json`), {
      ...manifestBase,
      fixtureLanguage: spec.language,
      caseHash,
      referenceSolutionNotes: spec.referenceNotes,
      negativeControlWrongSolution: spec.negativeControl,
    });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "." : normalized.slice(0, index);
}

function verifierSource(): string {
  return `import { readFileSync, writeFileSync } from "node:fs";

const meta = JSON.parse(readFileSync("case-meta.json", "utf8"));
const source = readFileSync(meta.filePath, "utf8");
const assertions = meta.checks.map((check) => ({
  id: check.id,
  label: check.label,
  passed: source.includes(check.contains),
  weight: check.weight ?? 1,
  message: source.includes(check.contains)
    ? undefined
    : \`Expected \${meta.filePath} to contain \${JSON.stringify(check.contains)}\`,
}));
const totalWeight = assertions.reduce((sum, item) => sum + item.weight, 0);
const passedWeight = assertions
  .filter((item) => item.passed)
  .reduce((sum, item) => sum + item.weight, 0);
const passed = assertions.every((item) => item.passed);
const result = {
  passed,
  score: totalWeight > 0 ? passedWeight / totalWeight : passed ? 1 : 0,
  summary: passed
    ? "Fixture satisfies the WorkBench verifier."
    : "Fixture does not satisfy the WorkBench verifier.",
  assertions,
};

writeFileSync("verifier-result.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
process.exit(passed ? 0 : 1);
`;
}
