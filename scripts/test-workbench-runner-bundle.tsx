/* WorkBench runner bundle checks (run: npx tsx scripts/test-workbench-runner-bundle.tsx) */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { renderToStaticMarkup } from "react-dom/server";
import { PresetCards } from "../components/benchmark/run/PresetCards";
import { WorkBenchRunnerStatus } from "../components/benchmark/workbench/WorkBenchRunnerStatus";
import { getCertifiedRunGate } from "../lib/benchmark/certified/ui-gates";
import type { BenchRunnerHealth } from "../lib/client/bench-runner";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolveStop) => {
    if (child.exitCode !== null || child.killed) {
      resolveStop();
      return;
    }
    child.once("exit", () => resolveStop());
    child.kill();
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1_000).unref();
  });
}

async function startupOutput(
  script: string,
  runnerRoot: string,
  extraArgs: string[] = []
): Promise<string> {
  const port = 30_000 + Math.floor(Math.random() * 10_000);
  const child = spawn(process.execPath, [
    script,
    "--port",
    String(port),
    "--token",
    "bundle-test-token",
    "--root",
    runnerRoot,
    ...extraArgs,
  ], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (stdout.includes("Paste the URL and token")) return stdout;
      if (child.exitCode !== null) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    return stdout;
  } finally {
    await stop(child);
  }
}

async function runningHealth(
  script: string,
  runnerRoot: string
): Promise<{ health: BenchRunnerHealth; stdout: string }> {
  const port = 40_000 + Math.floor(Math.random() * 10_000);
  const token = "bundle-health-test-token";
  const child = spawn(
    process.execPath,
    [
      script,
      "--port",
      String(port),
      "--token",
      token,
      "--root",
      runnerRoot,
    ],
    {
      cwd: dirname(script),
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  try {
    let lastError = "";
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/bench/health`, {
          headers: { "x-runner-token": token },
        });
        if (response.ok) {
          return {
            health: (await response.json()) as BenchRunnerHealth,
            stdout,
          };
        }
        lastError = await response.text();
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (child.exitCode !== null) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error(`extracted bench runner did not become healthy: ${lastError}`);
  } finally {
    await stop(child);
  }
}

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function main(): Promise<void> {
const testRoot = await mkdtemp(join(tmpdir(), "aiboard-workbench-runner-bundle-test-"));
try {
const publicationDirectory = join(testRoot, "published");
const isolatedPublish = spawnSync(
  process.execPath,
  ["scripts/publish-downloads.mjs", "--output-dir", publicationDirectory],
  {
    cwd: repoRoot,
    encoding: "utf8",
  }
);
check("download publication succeeds in an isolated directory", isolatedPublish.status === 0, isolatedPublish.stderr);

const bundlePath = join(publicationDirectory, "aiboard-workbench-runner.zip");
let archive: JSZip | null = null;
try {
  archive = await JSZip.loadAsync(await readFile(bundlePath));
  check("publishes a readable aiboard-workbench-runner.zip", true);
} catch (error) {
  check(
    "publishes a readable aiboard-workbench-runner.zip",
    false,
    error instanceof Error ? error.message : error
  );
}

if (archive) {
  check("bundle contains bench-runner.mjs", archive.file("bench-runner.mjs") !== null);
  check(
    "bundle contains nested Runner V2 CLI",
    archive.file("aiboard-runner-v2/src/cli.ts") !== null
  );
  const packagedRunnerSources = Object.keys(archive.files)
    .filter((name) =>
      name.startsWith("aiboard-runner-v2/src/") && name.endsWith(".ts")
    )
    .sort();
  for (const archivePath of packagedRunnerSources) {
    const relativePath = archivePath.slice("aiboard-runner-v2/".length);
    const packaged = await archive.file(archivePath)!.async("string");
    const source = await readFile(join(repoRoot, "runner-v2", relativePath), "utf8");
    check(
      `bundle ${archivePath} matches Runner V2 source`,
      packaged === source.replace(/\r\n?/g, "\n")
    );
  }
  const packagedRetry = archive.file(
    "aiboard-runner-v2/src/provider-call-retry.ts"
  );
  check("bundle contains standalone Runner V2 provider retry", packagedRetry !== null);
  if (packagedRetry) {
    const content = await packagedRetry.async("string");
    check(
      "packaged Runner retry has no browser application imports",
      !/(?:from\s+["'](?:@\/|\.\.\/\.\.\/lib\/)|lib\/benchmark\/certified)/.test(content),
      content
    );
  }
  const readme = archive.file("README.md");
  check("bundle contains an installation README", readme !== null);
  if (readme) {
    const content = await readme.async("string");
    check(
      "bundle README documents dependency and browser setup after extraction",
      content.includes("npm install") && content.includes("npm run setup:browser"),
      content
    );
  }
  const installedDependencies = Object.keys(archive.files).filter((name) =>
    name.split("/").includes("node_modules")
  );
  check("bundle excludes installed node_modules", installedDependencies.length === 0, installedDependencies);

  const extractedDirectory = join(testRoot, "extracted");
  for (const [name, entry] of Object.entries(archive.files)) {
    if (entry.dir) continue;
    const destination = join(extractedDirectory, ...name.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await entry.async("nodebuffer"));
  }
  const extracted = await runningHealth(
    join(extractedDirectory, "bench-runner.mjs"),
    join(testRoot, "extracted-runs")
  );
  check(
    "extracted bundle with source but no dependencies reports managed Runner V2 unavailable",
    extracted.health.runnerV2?.ready === false &&
      extracted.health.runnerV2.source === "sibling" &&
      extracted.health.runnerV2.error?.includes("npm install") === true,
    extracted
  );
  const unavailableMarkup = renderToStaticMarkup(
    <WorkBenchRunnerStatus
      idPrefix="bundle-health"
      url="http://127.0.0.1:8797"
      token="bundle-health-test-token"
      health={extracted.health}
      checking={false}
      onUrlChange={() => undefined}
      onTokenChange={() => undefined}
      onCheck={() => undefined}
    />
  );
  check(
    "source-present dependencies-absent health does not pass the WorkBench UI readiness status",
    !unavailableMarkup.includes("Managed Runner V2 ready") &&
      unavailableMarkup.includes("npm install"),
    unavailableMarkup
  );
  const runGate = getCertifiedRunGate({
    suiteId: "workbench-all",
    running: false,
    selectedTrack: "workbench",
    modelId: "test-model",
    teamModelIds: [],
    workBenchModelIds: ["test-model"],
    workBenchRoleMode: "solo",
    workBenchRunnerReady:
      extracted.health.ok && extracted.health.runnerV2?.ready === true,
    certification: {
      id: "bundle-test-certification",
      createdAt: "2026-07-26T00:00:00.000Z",
      aiboardVersion: "test",
      benchmarkEngineVersion: "test",
      harnessProfile: "aiboard-build-single-worker",
      harnessVersion: "test",
      promptSetVersion: "test",
      passed: true,
      checks: [],
    },
  });
  check(
    "source-present dependencies-absent health does not pass the WorkBench run gate",
    !runGate.canRun && runGate.reason === "Connect the WorkBench bench runner before running.",
    runGate
  );
}

const runnerStatusMarkup = renderToStaticMarkup(
  <WorkBenchRunnerStatus
    idPrefix="full-certified"
    url=""
    token=""
    health={null}
    checking={false}
    onUrlChange={() => undefined}
    onTokenChange={() => undefined}
    onCheck={() => undefined}
  />
);
const advancedRunnerStatusMarkup = renderToStaticMarkup(
  <WorkBenchRunnerStatus
    idPrefix="advanced-workbench"
    url=""
    token=""
    health={null}
    checking={false}
    onUrlChange={() => undefined}
    onTokenChange={() => undefined}
    onCheck={() => undefined}
  />
);
const presetMarkup = renderToStaticMarkup(
  <PresetCards
    busy={false}
    runningPresetId={null}
    focusedPresetId="full-certified"
    gates={{
      "model-iq": { disabled: false },
      "team-benchmark": { disabled: false },
      "full-certified": { disabled: false },
    }}
    onFocus={() => undefined}
    onRun={() => undefined}
  />
);
check(
  "shared runner status downloads the complete WorkBench runner bundle",
  runnerStatusMarkup.includes('href="/aiboard-workbench-runner.zip"') &&
    runnerStatusMarkup.includes('download="aiboard-workbench-runner.zip"') &&
    runnerStatusMarkup.includes("Download WorkBench runner bundle") &&
    runnerStatusMarkup.includes("Runner V2") &&
    runnerStatusMarkup.includes("npm install") &&
    runnerStatusMarkup.includes("npm run setup:browser"),
  runnerStatusMarkup
);
check(
  "Full certified preset card leaves runner setup to the shared panel",
  !presetMarkup.includes("Download WorkBench runner bundle") &&
    !presetMarkup.includes("/aiboard-workbench-runner.zip"),
  presetMarkup
);
check(
  "runner status instances use unique label and input ids",
  runnerStatusMarkup.includes('for="full-certified-runner-url"') &&
    runnerStatusMarkup.includes('id="full-certified-runner-url"') &&
    runnerStatusMarkup.includes('for="full-certified-runner-token"') &&
    runnerStatusMarkup.includes('id="full-certified-runner-token"') &&
    advancedRunnerStatusMarkup.includes('for="advanced-workbench-runner-url"') &&
    advancedRunnerStatusMarkup.includes('id="advanced-workbench-runner-url"') &&
    advancedRunnerStatusMarkup.includes('for="advanced-workbench-runner-token"') &&
    advancedRunnerStatusMarkup.includes('id="advanced-workbench-runner-token"'),
  { runnerStatusMarkup, advancedRunnerStatusMarkup }
);
check(
  "runner fields stack by default and keep the required wide-layout minimums",
  runnerStatusMarkup.includes("@container") &&
    runnerStatusMarkup.includes("minmax(18rem,1fr)") &&
    runnerStatusMarkup.includes("minmax(16rem,0.8fr)") &&
    !runnerStatusMarkup.includes("md:grid-cols-[1fr_0.8fr_auto]"),
  runnerStatusMarkup
);
const downloadLinkMarkup =
  runnerStatusMarkup.match(
    /<a[^>]*href="\/aiboard-workbench-runner\.zip"[^>]*>[\s\S]*?<\/a>/
  )?.[0] ?? "";
const downloadLinkClasses =
  downloadLinkMarkup.match(/class="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];
check(
  "320px runner status reflows the download action without intrinsic-width overflow",
  downloadLinkClasses.includes("w-full") &&
    downloadLinkClasses.includes("min-w-0") &&
    downloadLinkClasses.includes("h-auto") &&
    downloadLinkClasses.includes("whitespace-normal") &&
    !downloadLinkClasses.includes("whitespace-nowrap") &&
    downloadLinkClasses.includes("break-words") &&
    downloadLinkClasses.includes("@[32rem]:w-auto") &&
    downloadLinkClasses.includes("@[32rem]:h-10") &&
    downloadLinkClasses.includes("@[32rem]:whitespace-nowrap"),
  downloadLinkMarkup
);

const certifiedRunPanelSource = await readFile(
  join(repoRoot, "components", "benchmark", "certified", "CertifiedRunPanel.tsx"),
  "utf8"
);
check(
  "Full certified focus renders shared runner controls immediately after preset cards",
  /<PresetCards[\s\S]*?\/>\s*\{focusedPresetId === "full-certified" && \(\s*<WorkBenchRunnerStatus/.test(
    certifiedRunPanelSource
  ),
  certifiedRunPanelSource
);

const readyOutput = await startupOutput(
  join(repoRoot, "scripts", "bench-runner.mjs"),
  join(testRoot, "ready-runs")
);
check(
  "startup banner identifies the ready managed Runner V2 source",
  /Managed Runner V2: ready \((?:explicit|sibling|repository)\)/.test(readyOutput),
  readyOutput
);

const isolatedDirectory = await mkdtemp(join(tmpdir(), "aiboard-bench-runner-isolated-"));
try {
  const isolatedScript = join(isolatedDirectory, "bench-runner.mjs");
  await copyFile(join(repoRoot, "scripts", "bench-runner.mjs"), isolatedScript);
  await copyFile(
    join(repoRoot, "scripts", "workbench-rjs-support.mjs"),
    join(isolatedDirectory, "workbench-rjs-support.mjs")
  );
  const unavailableOutput = await startupOutput(
    isolatedScript,
    join(testRoot, "unavailable-runs")
  );
  check(
    "startup banner gives the exact Runner V2 setup command when unavailable",
    unavailableOutput.includes("Managed Runner V2: unavailable") &&
      unavailableOutput.includes(
        "Setup command: node bench-runner.mjs --runner-v2-dir C:\\path\\to\\aiboard-runner-v2"
      ),
    unavailableOutput
  );
} finally {
  await rm(isolatedDirectory, { recursive: true, force: true });
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await rm(testRoot, { recursive: true, force: true });
}
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
