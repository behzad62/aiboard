/* WorkBench runner bundle checks (run: npx tsx scripts/test-workbench-runner-bundle.tsx) */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { renderToStaticMarkup } from "react-dom/server";
import { PresetCards } from "../components/benchmark/run/PresetCards";
import { WorkBenchRunnerStatus } from "../components/benchmark/workbench/WorkBenchRunnerStatus";

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

async function startupOutput(script: string, extraArgs: string[] = []): Promise<string> {
  const port = 30_000 + Math.floor(Math.random() * 10_000);
  const child = spawn(process.execPath, [
    script,
    "--port",
    String(port),
    "--token",
    "bundle-test-token",
    "--root",
    join(tmpdir(), `aiboard-workbench-bundle-${port}`),
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

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function main(): Promise<void> {
const publish = spawnSync(process.execPath, ["scripts/publish-downloads.mjs"], {
  cwd: repoRoot,
  encoding: "utf8",
});
check("download publication succeeds", publish.status === 0, publish.stderr);

const bundlePath = join(repoRoot, "public", "aiboard-workbench-runner.zip");
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
}

const runnerStatusMarkup = renderToStaticMarkup(
  <WorkBenchRunnerStatus
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
    running={false}
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
for (const [surface, markup] of [
  ["runner status", runnerStatusMarkup],
  ["full-certified preset", presetMarkup],
] as const) {
  check(
    `${surface} downloads the complete WorkBench runner bundle`,
    markup.includes('href="/aiboard-workbench-runner.zip"') &&
      markup.includes('download="aiboard-workbench-runner.zip"') &&
      markup.includes("Download WorkBench runner bundle") &&
      markup.includes("Runner V2") &&
      markup.includes("npm install") &&
      markup.includes("npm run setup:browser"),
    markup
  );
}

const readyOutput = await startupOutput(join(repoRoot, "scripts", "bench-runner.mjs"));
check(
  "startup banner identifies the ready managed Runner V2 source",
  /Managed Runner V2: ready \((?:explicit|sibling|repository)\)/.test(readyOutput),
  readyOutput
);

const isolatedDirectory = await mkdtemp(join(tmpdir(), "aiboard-bench-runner-isolated-"));
try {
  const isolatedScript = join(isolatedDirectory, "bench-runner.mjs");
  await copyFile(join(repoRoot, "scripts", "bench-runner.mjs"), isolatedScript);
  const unavailableOutput = await startupOutput(isolatedScript);
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

process.exit(failures === 0 ? 0 : 1);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
