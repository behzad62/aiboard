// PX-2t — repeatable git-launch measurement through the production entry point.
//
// Run (cwd = repository root, quiet machine):
//   $env:NODE_TEST_CONTEXT=""; & "C:\Program Files\nodejs\node.exe" .\node_modules\tsx\dist\cli.mjs runner-v2/scripts/measure-git-launch.mts [n]
//
// Measures `binding.git.lifecycle("integration")` end to end on the real
// execution host with the production-selected backend: a no-output command
// (`git status --porcelain=v1` on a clean repo) and a large-output command
// (`git ls-files` over thousands of committed files). Reports median, p90,
// min, max per command plus mean Job-host fence effects per call (counted by
// wrapping the real host instance at the `windowsJobHost` seam — production
// code, instrumented exactly like the PX-1 prototype wraps).
//
// Writes NOTHING into the repository: all fixture state lives under a temp
// directory that is removed before exit.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { createWindowsJobProcessHost, type WindowsJobProcessHost } from "../src/windows-job-process-host.js";

const EFFECT_METHODS = [
  "launchOwned",
  "reconcileOwned",
  "readOwnedOutput",
  "signalOwned",
  "releaseOwned",
  "attachOwnedChannel",
  "writeOwnedInput",
  "closeOwnedInput",
  "acknowledgeOwnedOutput",
  "claimOwnedFence",
  "claimAndAttachOwnedChannel",
] as const;

type EffectCounts = Record<(typeof EFFECT_METHODS)[number], number>;

function zeroCounts(): EffectCounts {
  return {
    launchOwned: 0,
    reconcileOwned: 0,
    readOwnedOutput: 0,
    signalOwned: 0,
    releaseOwned: 0,
    attachOwnedChannel: 0,
    writeOwnedInput: 0,
    closeOwnedInput: 0,
    acknowledgeOwnedOutput: 0,
    claimOwnedFence: 0,
    claimAndAttachOwnedChannel: 0,
  };
}

/** Wrap the real Job host so every fence-effect method call is counted. */
function countingHost(inner: WindowsJobProcessHost, counts: EffectCounts): WindowsJobProcessHost {
  const wrapped: Record<string, unknown> = {};
  for (const name of EFFECT_METHODS) {
    const original = (inner as unknown as Record<string, unknown>)[name];
    if (typeof original !== "function") continue;
    wrapped[name] = (...args: unknown[]) => {
      counts[name] += 1;
      return (original as (...callArgs: unknown[]) => unknown).apply(inner, args);
    };
  }
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (typeof property === "string" && property in wrapped) return wrapped[property];
      return Reflect.get(target, property, receiver);
    },
  });
}

// Quantiles use the upper-middle element for even n
// (index floor(p*n)); "median" is quantile(0.5) by that rule, stated so
// PX-1's 934 ms rev-parse number can be compared without re-measuring.
function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const quantile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  return {
    n: sorted.length,
    median: Math.round(quantile(0.5) * 10) / 10,
    p90: Math.round(quantile(0.9) * 10) / 10,
    min: Math.round(sorted[0]! * 10) / 10,
    max: Math.round(sorted[sorted.length - 1]! * 10) / 10,
  };
}

const n = Math.max(1, Number(process.argv[2] ?? 20) || 20);
const LARGE_FILES = 4000;

const root = mkdtempSync(join(tmpdir(), "aiboard-measure-git-launch-"));
try {
  const gitSetup = (...args: string[]) =>
    execFileSync("git", ["-c", "core.autocrlf=false", ...args], { stdio: ["ignore", "pipe", "ignore"] });
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  // Small repo for the no-output command: `git status` stays cheap because no
  // large tree is ever scanned here.
  const quietRepo = join(project, "quiet");
  mkdirSync(quietRepo);
  gitSetup("init", "-q", quietRepo);
  gitSetup("-C", quietRepo, "config", "user.email", "measure@example.test");
  gitSetup("-C", quietRepo, "config", "user.name", "measure");
  writeFileSync(join(quietRepo, "base.txt"), "measure\n");
  gitSetup("-C", quietRepo, "add", ".");
  gitSetup("-C", quietRepo, "commit", "-qm", "measure");
  // Large repo for the large-output command. It lives beside the small repo,
  // never inside it, so the quiet command never scans it.
  const largeRepo = join(project, "large");
  mkdirSync(largeRepo);
  gitSetup("init", "-q", largeRepo);
  gitSetup("-C", largeRepo, "config", "user.email", "measure@example.test");
  gitSetup("-C", largeRepo, "config", "user.name", "measure");
  const batch = join(largeRepo, "many");
  mkdirSync(batch);
  for (let i = 0; i < LARGE_FILES; i += 1) {
    writeFileSync(join(batch, `f${String(i).padStart(5, "0")}.txt`), `row ${i}\n`);
  }
  gitSetup("-C", largeRepo, "add", ".");
  gitSetup("-C", largeRepo, "commit", "-qm", "measure");

  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const counts = zeroCounts();
  const service = countingHost(
    createWindowsJobProcessHost({ stateDirectory: join(stateDir, "managed-processes-job-host") }),
    counts,
  );
  const host = createExecutionHost({
    projectRoot: project,
    stateDirectory: stateDir,
    artifacts: new ArtifactStore(join(stateDir, "artifacts")),
    ambientEnvironment: { ...process.env },
    windowsJobHost: service,
  });
  const binding = await host.bindRun({
    runId: `measure-git-launch-${Date.now()}`,
    permissionProfile: "full",
    capabilityContract: { digest: "c".repeat(64) } as never,
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
  });
  try {
    const git = binding.git.lifecycle("integration");
    const quiet = { cwd: quietRepo, args: ["status", "--porcelain=v1"] };
    const large = { cwd: largeRepo, args: ["ls-files"] };
    // Same-command comparison with PX-1's `rev-parse HEAD` number.
    const revparse = { cwd: quietRepo, args: ["rev-parse", "HEAD"] };
    // Warmup (semantic probes, JIT, cold PowerShell): dropped.
    for (let i = 0; i < 2; i += 1) {
      await git.run(quiet);
      await git.run(large);
      await git.run(revparse);
    }
    const largeBytes = Buffer.byteLength((await git.run(large)).stdout, "utf8");

    const measure = async (options: { cwd: string; args: string[] }): Promise<{ ms: number; effects: EffectCounts }> => {
      const mark = zeroCounts();
      for (const name of EFFECT_METHODS) (counts as Record<string, number>)[name] = 0;
      const start = performance.now();
      await git.run(options);
      const ms = performance.now() - start;
      for (const name of EFFECT_METHODS) mark[name] = counts[name];
      return { ms, effects: mark };
    };

    const quietSamples: number[] = [];
    const quietEffects: EffectCounts[] = [];
    for (let i = 0; i < n; i += 1) {
      const sample = await measure(quiet);
      quietSamples.push(sample.ms);
      quietEffects.push(sample.effects);
    }
    const largeSamples: number[] = [];
    const largeEffects: EffectCounts[] = [];
    for (let i = 0; i < n; i += 1) {
      const sample = await measure(large);
      largeSamples.push(sample.ms);
      largeEffects.push(sample.effects);
    }
    const revparseSamples: number[] = [];
    const revparseEffects: EffectCounts[] = [];
    for (let i = 0; i < n; i += 1) {
      const sample = await measure(revparse);
      revparseSamples.push(sample.ms);
      revparseEffects.push(sample.effects);
    }
    const meanEffects = (sets: EffectCounts[]): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const name of EFFECT_METHODS) {
        out[name] = Math.round((sets.reduce((sum, set) => sum + set[name], 0) / sets.length) * 100) / 100;
      }
      out.total = Math.round(Object.values(out).reduce((a, b) => a + b, 0) * 100) / 100;
      return out;
    };
    const jobRecords = readdirSync(join(stateDir, "managed-processes-job-host")).filter((entry) =>
      entry.endsWith(".json"),
    ).length;
    console.log(
      JSON.stringify(
        {
          machine: { platform: process.platform, node: process.version },
          n,
          backend: "production-selected",
          jobBackendRecords: jobRecords,
          jobBackend: jobRecords > 0,
          quietCommand: "git status --porcelain=v1 (no output)",
          quiet: stats(quietSamples),
          quietFenceEffectsPerCall: meanEffects(quietEffects),
          largeCommand: `git ls-files (${LARGE_FILES} files, ${largeBytes} stdout bytes)`,
          large: stats(largeSamples),
          largeFenceEffectsPerCall: meanEffects(largeEffects),
          revparseCommand: "git rev-parse HEAD (same command as PX-1)",
          revparse: stats(revparseSamples),
          revparseFenceEffectsPerCall: meanEffects(revparseEffects),
        },
        null,
        1,
      ),
    );
    await binding.close();
  } finally {
    await host.close();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
