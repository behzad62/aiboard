/** Runner /repo/status and /repo/diff checks (run: npx tsx scripts/test-runner-repo-status.mts) */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

async function get(port: number, token: string, endpoint: string) {
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    headers: { "x-runner-token": token },
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function post(port: number, token: string, endpoint: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runner-token": token },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function waitForRunner(port: number, token: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { "x-runner-token": token },
      });
      if (res.ok) return;
    } catch {
      // runner is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("runner did not start");
}

/** Run a git command inside a temp repo; throws (with output) on failure. */
function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/** Create a temp git repo with a deterministic local identity (no network). */
function initRepo(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "runner-test@example.com"]);
  git(dir, ["config", "user.name", "Runner Test"]);
  // Some git setups need an explicit default branch name on first commit.
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

async function startRunner(dir: string) {
  const port = 19_500 + Math.floor(Math.random() * 1_000);
  const token = "test-token";
  let log = "";
  const child = spawn(
    process.execPath,
    ["scripts/runner.mjs", dir, "--port", String(port), "--token", token],
    { cwd: process.cwd(), windowsHide: true }
  ) as ChildProcessWithoutNullStreams;
  child.stdout.on("data", (c) => (log += String(c)));
  child.stderr.on("data", (c) => (log += String(c)));
  await waitForRunner(port, token);
  return { port, token, child, getLog: () => log };
}

const cleanups: Array<() => void> = [];
function later(fn: () => void) {
  cleanups.push(fn);
}

try {
  // ── 1. Non-repo folder ────────────────────────────────────────────────────
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adb-runner-norepo-"));
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    const runner = await startRunner(dir);
    later(() => runner.child.kill());

    const { res, data } = await get(runner.port, runner.token, "/repo/status");
    check("non-repo: HTTP 200", res.status === 200, data);
    check("non-repo: gitAvailable true", data.gitAvailable === true, data);
    check("non-repo: isRepo false (not an error)", data.isRepo === false && !data.error, data);
    check("non-repo: root null", data.root === null, data);
    runner.child.kill();
  }

  // ── 2. Clean repo with a commit ───────────────────────────────────────────
  {
    const dir = initRepo("adb-runner-clean-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "README.txt"), "hello\n", "utf8");
    git(dir, ["add", "README.txt"]);
    git(dir, ["commit", "-m", "initial commit"]);

    const runner = await startRunner(dir);
    later(() => runner.child.kill());

    const { res, data } = await get(runner.port, runner.token, "/repo/status");
    check("clean: HTTP 200", res.status === 200, data);
    check("clean: isRepo true", data.isRepo === true, data);
    check("clean: root is a string", typeof data.root === "string" && data.root.length > 0, data);
    check("clean: clean === true", data.clean === true, data);
    check(
      "clean: no staged/unstaged/untracked/conflicted",
      data.staged.length === 0 &&
        data.unstaged.length === 0 &&
        data.untracked.length === 0 &&
        data.conflicted.length === 0,
      data
    );
    check("clean: currentBranch set", typeof data.currentBranch === "string" && data.currentBranch.length > 0, data);
    check("clean: recentCommits has the commit", data.recentCommits?.[0]?.subject === "initial commit", data);
    check("clean: recentCommit hash present", typeof data.recentCommits?.[0]?.hash === "string" && data.recentCommits[0].hash.length > 0, data);
    check("clean: no upstream", data.upstream === null, data);
    check("clean: ahead/behind zero", data.ahead === 0 && data.behind === 0, data);
    check("clean: remotes empty array", Array.isArray(data.remotes) && data.remotes.length === 0, data);
    runner.child.kill();
  }

  // ── 3. Repo with staged / unstaged / untracked / conflicted files ─────────
  {
    const dir = initRepo("adb-runner-dirty-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));

    // Base commit on a known branch.
    fs.writeFileSync(path.join(dir, "tracked.txt"), "base\n", "utf8");
    fs.writeFileSync(path.join(dir, "conflict.txt"), "base\n", "utf8");
    git(dir, ["add", "tracked.txt", "conflict.txt"]);
    git(dir, ["commit", "-m", "base"]);
    const baseBranch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();

    // Build a real merge conflict on conflict.txt.
    git(dir, ["checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(dir, "conflict.txt"), "feature change\n", "utf8");
    git(dir, ["commit", "-am", "feature edit"]);
    git(dir, ["checkout", baseBranch]);
    fs.writeFileSync(path.join(dir, "conflict.txt"), "main change\n", "utf8");
    git(dir, ["commit", "-am", "main edit"]);
    const merge = spawnSync("git", ["merge", "feature"], { cwd: dir, encoding: "utf8" });
    check("dirty: merge produced a conflict", merge.status !== 0, merge.stderr || merge.stdout);

    // A staged-but-not-committed new file.
    fs.writeFileSync(path.join(dir, "staged.txt"), "staged\n", "utf8");
    git(dir, ["add", "staged.txt"]);

    // An unstaged modification to a tracked file.
    fs.writeFileSync(path.join(dir, "tracked.txt"), "base\nmodified\n", "utf8");

    // An untracked file.
    fs.writeFileSync(path.join(dir, "untracked.txt"), "new\n", "utf8");

    const runner = await startRunner(dir);
    later(() => runner.child.kill());

    const { res, data } = await get(runner.port, runner.token, "/repo/status");
    check("dirty: HTTP 200", res.status === 200, data);
    check("dirty: isRepo true", data.isRepo === true, data);
    check("dirty: clean === false", data.clean === false, data);
    check("dirty: staged includes staged.txt", data.staged.includes("staged.txt"), data.staged);
    check("dirty: unstaged includes tracked.txt", data.unstaged.includes("tracked.txt"), data.unstaged);
    check("dirty: untracked includes untracked.txt", data.untracked.includes("untracked.txt"), data.untracked);
    check("dirty: conflicted includes conflict.txt", data.conflicted.includes("conflict.txt"), data.conflicted);
    check(
      "dirty: conflict.txt is only reported as conflicted (not staged/unstaged)",
      !data.staged.includes("conflict.txt") && !data.unstaged.includes("conflict.txt"),
      data
    );
    runner.child.kill();
  }

  // ── 4. /repo/diff ─────────────────────────────────────────────────────────
  {
    const dir = initRepo("adb-runner-diff-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "a.txt"), "line one\n", "utf8");
    fs.writeFileSync(path.join(dir, "b.txt"), "bee one\n", "utf8");
    git(dir, ["add", "a.txt", "b.txt"]);
    git(dir, ["commit", "-m", "seed"]);

    // Unstaged change to a.txt.
    fs.writeFileSync(path.join(dir, "a.txt"), "line one changed\n", "utf8");
    // Staged change to b.txt.
    fs.writeFileSync(path.join(dir, "b.txt"), "bee one changed\n", "utf8");
    git(dir, ["add", "b.txt"]);

    const runner = await startRunner(dir);
    later(() => runner.child.kill());

    const unstaged = await post(runner.port, runner.token, "/repo/diff", {});
    check("diff: default returns HTTP 200", unstaged.res.status === 200, unstaged.data);
    check("diff: default shows unstaged a.txt change", unstaged.data.diff.includes("line one changed"), unstaged.data);
    check("diff: default does NOT show staged b.txt change", !unstaged.data.diff.includes("bee one changed"), unstaged.data);
    check("diff: reports bytes and truncated", typeof unstaged.data.bytes === "number" && unstaged.data.truncated === false, unstaged.data);

    const staged = await post(runner.port, runner.token, "/repo/diff", { staged: true });
    check("diff: staged returns HTTP 200", staged.res.status === 200, staged.data);
    check("diff: staged shows staged b.txt change", staged.data.diff.includes("bee one changed"), staged.data);
    check("diff: staged does NOT show unstaged a.txt change", !staged.data.diff.includes("line one changed"), staged.data);

    const statDiff = await post(runner.port, runner.token, "/repo/diff", { stat: true });
    check("diff: stat returns HTTP 200", statDiff.res.status === 200, statDiff.data);
    check("diff: stat output mentions a.txt", statDiff.data.diff.includes("a.txt"), statDiff.data);

    const scoped = await post(runner.port, runner.token, "/repo/diff", { paths: ["a.txt"] });
    check("diff: scoped to a.txt shows a.txt", scoped.data.diff.includes("line one changed"), scoped.data);

    const scopedOther = await post(runner.port, runner.token, "/repo/diff", { paths: ["b.txt"] });
    check("diff: scoped to b.txt (unstaged) is empty", scopedOther.data.diff.trim() === "", scopedOther.data);

    // Unsafe path rejection.
    const abs = await post(runner.port, runner.token, "/repo/diff", { paths: ["/etc/passwd"] });
    check("diff: rejects absolute path (HTTP 400)", abs.res.status === 400 && !!abs.data.error, abs.data);

    const traversal = await post(runner.port, runner.token, "/repo/diff", { paths: ["../escape.txt"] });
    check("diff: rejects traversal path (HTTP 400)", traversal.res.status === 400 && !!traversal.data.error, traversal.data);

    runner.child.kill();
  }

  // ── 5. Existing endpoints still work ──────────────────────────────────────
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adb-runner-regress-"));
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "keep.txt"), "keep me\n", "utf8");
    const runner = await startRunner(dir);
    later(() => runner.child.kill());

    const health = await get(runner.port, runner.token, "/health");
    check("regression: /health ok", health.res.status === 200 && health.data.ok === true, health.data);

    const ls = await get(runner.port, runner.token, "/ls");
    check("regression: /ls lists files", ls.res.status === 200 && Array.isArray(ls.data.files) && ls.data.files.includes("keep.txt"), ls.data);

    const read = await post(runner.port, runner.token, "/read", { path: "keep.txt" });
    check("regression: /read returns content", read.res.status === 200 && read.data.content.includes("keep me"), read.data);

    runner.child.kill();
  }
} finally {
  for (const fn of cleanups) {
    try {
      fn();
    } catch {
      // best-effort cleanup
    }
  }
}

process.exit(failed === 0 ? 0 : 1);
