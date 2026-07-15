import { spawnSync } from "node:child_process";

const script = "scripts/generate-gameiq-chess-depth.mts";
const args = [
  "node_modules/tsx/dist/cli.mjs",
  script,
  "--seed",
  "1",
  "--want",
  "1",
  "--max-scanned",
  "1",
];

function runMiner(extraArgs: string[] = []): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [...args, ...extraArgs], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

const first = runMiner();
if (first.status !== 0) {
  fail(`miner exits successfully: ${first.stderr || first.stdout}`);
}

const second = runMiner();
if (second.status !== 0) {
  fail(`repeat miner exits successfully: ${second.stderr || second.stdout}`);
}

if (first.stdout !== second.stdout) {
  fail("same seed produces byte-identical stdout");
}

const diagnostic = runMiner(["--diagnostics"]);
if (diagnostic.status !== 0) {
  fail(`diagnostic miner exits successfully: ${diagnostic.stderr || diagnostic.stdout}`);
}
if (diagnostic.stdout !== first.stdout) {
  fail("--diagnostics preserves byte-identical stdout");
}
if (!/^diagnostics=\{.*\}\r?\n$/.test(diagnostic.stderr)) {
  fail(`--diagnostics emits one JSON record on stderr: ${diagnostic.stderr}`);
}

const lines = first.stdout.trimEnd().split("\n");
const header = /^seed=1 games=(\d+) scanned=(\d+) candidates=(\d+)$/.exec(lines[0] ?? "");
if (!header) {
  fail(`first line is the deterministic summary: ${lines[0] ?? "<empty>"}`);
}

const games = Number(header[1]);
const scanned = Number(header[2]);
const candidates = Number(header[3]);
if (!Number.isInteger(games) || games < 1 || games > 400) {
  fail(`games remains within the per-seed bound: ${games}`);
}
if (!Number.isInteger(scanned) || scanned !== 1) {
  fail(`test scan cap is honored: ${scanned}`);
}
if (!Number.isInteger(candidates) || candidates < 0 || candidates > 1) {
  fail(`candidate count respects --want: ${candidates}`);
}
if (lines.length !== candidates + 1) {
  fail(`summary candidate count matches JSON-line records: ${lines.length - 1}`);
}

for (const line of lines.slice(1)) {
  let candidate: unknown;
  try {
    candidate = JSON.parse(line);
  } catch {
    fail(`candidate is valid JSON: ${line}`);
  }
  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof (candidate as { fen?: unknown }).fen !== "string" ||
    !/^[^ ]+ [wb] /.test((candidate as { fen: string }).fen) ||
    typeof (candidate as { key?: { from?: unknown } }).key?.from !== "string" ||
    typeof (candidate as { key?: { to?: unknown } }).key?.to !== "string" ||
    !Number.isInteger((candidate as { legalMoveCount?: unknown }).legalMoveCount) ||
    !Number.isInteger((candidate as { forcingBaitCount?: unknown }).forcingBaitCount)
  ) {
    fail(`candidate satisfies the JSON-lines contract: ${line}`);
  }
}

console.log("PASS deterministic chess depth miner CLI contract");
