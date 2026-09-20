import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const runnerRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(runnerRoot, "..");
const publisher = join(repoRoot, "scripts", "publish-downloads.mjs");

test("packaged Runner command works after a real install outside the source tree", async () => {
  const temp = mkdtempSync(join(tmpdir(), "aiboard-runner-entrypoint-"));
  try {
    const published = join(temp, "published");
    const installed = join(temp, "installed");
    mkdirSync(published, { recursive: true });
    mkdirSync(installed, { recursive: true });
    execFileSync(process.execPath, [publisher, "--output-dir", published], { cwd: repoRoot, stdio: "pipe" });
    const zip = await JSZip.loadAsync(readFileSync(join(published, "aiboard-runner-v2.zip")));
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const destination = resolve(installed, name);
      assert.ok(destination.startsWith(resolve(installed) + "\\") || destination.startsWith(resolve(installed) + "/"));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, await entry.async("nodebuffer"));
    }
    const packaged = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as { bin?: Record<string, string> };
    const target = packaged.bin?.["aiboard-runner-v2"];
    assert.ok(target, "Packaged Runner command is missing.");
    const installedEntrypoint = resolve(installed, target);
    assert.equal(existsSync(installedEntrypoint), true, `Packaged Runner command target is missing: ${target}`);

    const npm = npmCommand(["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
    execFileSync(npm.file, npm.args, {
      cwd: installed,
      stdio: "pipe",
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    });

    const sourcePackage = JSON.parse(readFileSync(join(runnerRoot, "package.json"), "utf8")) as { bin: Record<string, string> };
    const sourceEntrypoint = resolve(runnerRoot, sourcePackage.bin["aiboard-runner-v2"]!);
    const sourceHelp = execFileSync(process.execPath, [sourceEntrypoint, "--help"], { cwd: runnerRoot, encoding: "utf8" });
    const installedHelp = execFileSync(process.execPath, [installedEntrypoint, "--help"], { cwd: installed, encoding: "utf8" });
    assert.equal(installedHelp, sourceHelp);
    assert.match(installedHelp, /AI Board Runner V2/i);

    const npmStart = npmCommand(["start", "--", "--help"]);
    const installedStartHelp = execFileSync(npmStart.file, npmStart.args, { cwd: installed, encoding: "utf8" });
    assert.match(installedStartHelp, /AI Board Runner V2/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function npmCommand(args: readonly string[]): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd", ...args] };
  }
  return { file: "npm", args: [...args] };
}