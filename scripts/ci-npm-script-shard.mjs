#!/usr/bin/env node
// Runs one shard of an npm script, so CI can spread a long `a && b && npm run c` chain over parallel jobs.
//
//   node scripts/ci-npm-script-shard.mjs <script> --shard <index>/<count>   run shard <index> (1-based)
//   node scripts/ci-npm-script-shard.mjs <script> --list [--shard i/n]      print the commands, run nothing
//
// The npm script stays the only list of commands: this expands every `npm run x` in it (recursively) into the
// commands it runs, and gives each command to exactly one shard, so the shards together run every command once.
// A command added to the npm script runs in some shard with no workflow change. Shards are balanced by the
// durations in WEIGHTS (seconds, measured on Windows, the slowest host); a command with no entry counts as
// DEFAULT_WEIGHT. Commands in a shard run in their order in the npm script and stop at the first failure, as `&&`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_WEIGHT = 1.3;

// Measured durations in seconds, for balancing only. A stale or missing entry can only unbalance the shards,
// never drop a command.
export const WEIGHTS = {
  "tsx scripts/test-recoverable-job-service-bundle.mts": 200,
  "tsx scripts/test-certified-model-call-retry.mts": 17,
  "tsx scripts/test-workbench-executor.mts": 11,
  "tsx scripts/test-workbench-current-challenges.mts": 11,
  "tsx scripts/test-native-benchmark-profiles.mts": 8,
  "tsx scripts/test-recoverable-job-service-runner-bridge.mts": 6,
  "tsx scripts/test-account-provider-runner-chat.mts": 4,
  "tsx scripts/test-certified-preset-cancellation.mts": 4,
  "tsx scripts/test-benchmark-run-outcomes.mts": 4,
  "tsx scripts/test-benchmark-decision-dashboard-ui.mts": 4,
};

/** Every command `npm run <script>` runs, in order. A script with any shell syntax besides `&&` stays one command. */
export function expandScript(scripts, name, seen = []) {
  const body = scripts[name];
  if (typeof body !== "string") throw new Error(`No npm script named ${name}.`);
  if (seen.includes(name)) throw new Error(`npm script ${name} runs itself: ${[...seen, name].join(" -> ")}.`);
  if (/[;|<>`&$"'()]/.test(body.replaceAll("&&", ""))) return [{ script: name, command: body.trim() }];
  return body.split("&&").map((part) => part.trim()).filter(Boolean).flatMap((command) => {
    const nested = command.match(/^npm run ([\w:.-]+)$/);
    return nested ? expandScript(scripts, nested[1], [...seen, name]) : [{ script: name, command }];
  });
}

/** Splits the commands into `count` shards: longest first onto the lightest shard; each shard keeps script order. */
export function assignShards(commands, count, weights = WEIGHTS) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`Shard count must be a positive integer, got ${count}.`);
  const weightOf = (entry) => weights[entry.command] ?? DEFAULT_WEIGHT;
  const order = commands.map((entry, index) => ({ entry, index }))
    .sort((a, b) => weightOf(b.entry) - weightOf(a.entry) || a.index - b.index);
  const shards = Array.from({ length: count }, () => ({ total: 0, items: [] }));
  for (const item of order) {
    const lightest = shards.reduce((best, shard, index) => (shard.total < shards[best].total ? index : best), 0);
    shards[lightest].total += weightOf(item.entry);
    shards[lightest].items.push(item);
  }
  return shards.map((shard) => ({
    estimatedSeconds: shard.total,
    commands: shard.items.sort((a, b) => a.index - b.index).map((item) => item.entry),
  }));
}

function parseShard(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) throw new Error(`--shard takes <index>/<count>, got ${value}.`);
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count < 1 || index < 1 || index > count) throw new Error(`--shard ${value} is out of range.`);
  return { index, count };
}

function main(argv) {
  const [script, ...rest] = argv;
  if (!script || script.startsWith("--")) throw new Error("Usage: ci-npm-script-shard.mjs <script> (--shard i/n | --list [--shard i/n])");
  const list = rest.includes("--list");
  const shardFlag = rest.indexOf("--shard");
  const { index, count } = shardFlag === -1 ? { index: 1, count: 1 } : parseShard(rest[shardFlag + 1]);
  if (shardFlag === -1 && !list) throw new Error("--shard <index>/<count> is required to run.");
  const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;
  const commands = expandScript(scripts, script);
  const shard = assignShards(commands, count)[index - 1];
  console.log(`${script}: shard ${index}/${count} runs ${shard.commands.length} of ${commands.length} commands (weight ${Math.round(shard.estimatedSeconds)}).`);
  if (list) {
    for (const entry of shard.commands) console.log(`  [${entry.script}] ${entry.command}`);
    return 0;
  }
  // As `npm run`: the package's bin folder first on PATH, the command through the platform shell, from the root.
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const env = { ...process.env, [pathKey]: [path.join(root, "node_modules", ".bin"), process.env[pathKey]].filter(Boolean).join(path.delimiter) };
  const timings = [];
  for (const entry of shard.commands) {
    console.log(`\n> [${entry.script}] ${entry.command}`);
    const started = Date.now();
    const result = spawnSync(entry.command, { cwd: root, env, shell: true, stdio: "inherit" });
    const seconds = (Date.now() - started) / 1000;
    timings.push({ seconds, command: entry.command });
    console.log(`TIME ${seconds.toFixed(1)} s ${entry.command}`);
    if (result.error || result.status !== 0) {
      console.error(`FAIL ${entry.command} (${result.error ? result.error.message : `exit ${result.status ?? result.signal}`}); the rest of this shard does not run.`);
      return result.status || 1;
    }
  }
  console.log(`\nShard ${index}/${count} passed. Slowest commands:`);
  for (const timing of timings.sort((a, b) => b.seconds - a.seconds).slice(0, 10)) console.log(`  ${timing.seconds.toFixed(1)} s ${timing.command}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
