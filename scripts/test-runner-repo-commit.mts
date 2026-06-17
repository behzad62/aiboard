/** Runner /repo/commit checks (run: npx tsx scripts/test-runner-repo-commit.mts) */
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
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

async function startRunner(dir: string) {
  const port = 19_700 + Math.floor(Math.random() * 1_000);
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

/** Seed a repo with an initial commit on a feature branch (the safe state). */
function seedFeatureRepo(prefix: string) {
  const dir = initRepo(prefix);
  fs.writeFileSync(path.join(dir, "README.txt"), "hello\n", "utf8");
  git(dir, ["add", "README.txt"]);
  git(dir, ["commit", "-m", "initial commit"]);
  git(dir, ["switch", "-c", "feature/work"]);
  return dir;
}

try {
  // ── 1. Happy path: commit all changes ─────────────────────────────────────
  {
    const dir = seedFeatureRepo("adb-runner-commit-all-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "feature.txt"), "new feature\n", "utf8");
    fs.writeFileSync(path.join(dir, "README.txt"), "hello\nworld\n", "utf8");

    const runner = await startRunner(dir);
    later(() => runner.child.kill());

    const { res, data } = await post(runner.port, runner.token, "/repo/commit", {
      message: "feat: add feature file",
    });
    check("commit-all: HTTP 200", res.status === 200, data);
    check("commit-all: ok envelope", data.ok === true, data);
    check("commit-all: returns a short hash", typeof data.hash === "string" && /^[0-9a-f]{6,}$/.test(data.hash), data);
    check("commit-all: subject matches message", data.subject === "feat: add feature file", data);
    check(
      "commit-all: committedFiles includes both changed files",
      Array.isArray(data.committedFiles) &&
        data.committedFiles.includes("feature.txt") &&
        data.committedFiles.includes("README.txt"),
      data
    );
    // The commit is actually in git history.
    const log = git(dir, ["log", "-1", "--pretty=format:%s"]);
    check("commit-all: git log shows the commit subject", log.trim() === "feat: add feature file", log);
    const headHash = git(dir, ["rev-parse", "--short", "HEAD"]).trim();
    check("commit-all: returned hash matches HEAD", headHash === data.hash, { headHash, hash: data.hash });
    // Working tree is now clean.
    const stat = git(dir, ["status", "--porcelain"]).trim();
    check("commit-all: working tree clean after commit", stat === "", stat);

    runner.child.kill();
  }

  // ── 2. Empty commit (nothing staged) is rejected ──────────────────────────
  {
    const dir = seedFeatureRepo("adb-runner-commit-empty-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));

    const runner = await startRunner(dir);
    later(() => runner.child.kill());

    const { res, data } = await post(runner.port, runner.token, "/repo/commit", {
      message: "chore: nothing to commit",
    });
    check("empty: HTTP 400", res.status === 400, { status: res.status, data });
    check("empty: clear error", typeof data.error === "string" && /stag|empty|nothing/i.test(data.error), data);
    // No new commit landed — still the seed commit.
    const log = git(dir, ["log", "-1", "--pretty=format:%s"]);
    check("empty: no new commit landed", log.trim() === "initial commit", log);

    runner.child.kill();
  }

  // ── 3. Message validation ─────────────────────────────────────────────────
  {
    const dir = seedFeatureRepo("adb-runner-commit-msg-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n", "utf8");

    const runner = await startRunner(dir);
    later(() => runner.child.kill());

    const empty = await post(runner.port, runner.token, "/repo/commit", { message: "   " });
    check("msg: rejects whitespace-only message (HTTP 400)", empty.res.status === 400 && !!empty.data.error, empty.data);

    const missing = await post(runner.port, runner.token, "/repo/commit", {});
    check("msg: rejects missing message (HTTP 400)", missing.res.status === 400 && !!missing.data.error, missing.data);

    const tooLong = await post(runner.port, runner.token, "/repo/commit", {
      message: "x".repeat(201),
    });
    check("msg: rejects >200-char message (HTTP 400)", tooLong.res.status === 400 && !!tooLong.data.error, tooLong.data);

    // Nothing should have been committed by any rejected request.
    const log = git(dir, ["log", "-1", "--pretty=format:%s"]);
    check("msg: no commit landed from rejected messages", log.trim() === "initial commit", log);

    runner.child.kill();
  }

  // ── 4. Unsafe path is rejected ────────────────────────────────────────────
  {
    const dir = seedFeatureRepo("adb-runner-commit-path-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n", "utf8");

    const runner = await startRunner(dir);
    later(() => runner.child.kill());

    const abs = await post(runner.port, runner.token, "/repo/commit", {
      message: "feat: bad path",
      paths: ["/etc/passwd"],
    });
    check("path: rejects absolute path (HTTP 400)", abs.res.status === 400 && !!abs.data.error, abs.data);

    const traversal = await post(runner.port, runner.token, "/repo/commit", {
      message: "feat: bad path",
      paths: ["../escape.txt"],
    });
    check("path: rejects traversal path (HTTP 400)", traversal.res.status === 400 && !!traversal.data.error, traversal.data);

    // No commit should have landed.
    const log = git(dir, ["log", "-1", "--pretty=format:%s"]);
    check("path: no commit landed from rejected paths", log.trim() === "initial commit", log);

    runner.child.kill();
  }

  // ── 5. Paths-scoped commit only commits those paths ───────────────────────
  {
    const dir = seedFeatureRepo("adb-runner-commit-scoped-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "included.txt"), "in\n", "utf8");
    fs.writeFileSync(path.join(dir, "excluded.txt"), "out\n", "utf8");

    const runner = await startRunner(dir);
    later(() => runner.child.kill());

    const { res, data } = await post(runner.port, runner.token, "/repo/commit", {
      message: "feat: only included",
      paths: ["included.txt"],
    });
    check("scoped: HTTP 200", res.status === 200, data);
    check(
      "scoped: committedFiles is exactly [included.txt]",
      Array.isArray(data.committedFiles) &&
        data.committedFiles.length === 1 &&
        data.committedFiles[0] === "included.txt",
      data
    );
    // The excluded file is still untracked / uncommitted.
    const stat = git(dir, ["status", "--porcelain"]).trim();
    check("scoped: excluded.txt remains untracked", stat.includes("excluded.txt"), stat);
    check("scoped: included.txt no longer pending", !stat.includes("included.txt"), stat);

    runner.child.kill();
  }

  // ── 5b. Root (first) commit reports its files ─────────────────────────────
  // A parentless commit needs `diff-tree --root`; otherwise committedFiles is
  // empty even though files were committed. Regression guard for that bug.
  {
    const dir = initRepo("adb-runner-commit-root-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    // No prior commit at all — the commit below is the repo's root commit.
    fs.writeFileSync(path.join(dir, "first.txt"), "first\n", "utf8");
    fs.writeFileSync(path.join(dir, "second.txt"), "second\n", "utf8");

    const runner = await startRunner(dir);
    later(() => runner.child.kill());

    const { res, data } = await post(runner.port, runner.token, "/repo/commit", {
      message: "feat: root commit",
    });
    check("root: HTTP 200", res.status === 200, data);
    check(
      "root: committedFiles is non-empty for the first commit",
      Array.isArray(data.committedFiles) &&
        data.committedFiles.includes("first.txt") &&
        data.committedFiles.includes("second.txt"),
      data
    );
    const log = git(dir, ["log", "-1", "--pretty=format:%s"]);
    check("root: git log shows the commit", log.trim() === "feat: root commit", log);

    runner.child.kill();
  }

  // Scoped commits must reject unrelated pre-staged files. Otherwise the
  // approval preview can list only action.paths while Git commits extra files
  // that were already in the index.
  {
    const dir = seedFeatureRepo("adb-runner-commit-prestaged-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "included.txt"), "in\n", "utf8");
    fs.writeFileSync(path.join(dir, "pre-staged.txt"), "pre\n", "utf8");
    git(dir, ["add", "pre-staged.txt"]);

    const runner = await startRunner(dir);
    later(() => runner.child.kill());

    const { res, data } = await post(runner.port, runner.token, "/repo/commit", {
      message: "feat: only included",
      paths: ["included.txt"],
    });
    check("prestaged: scoped commit is rejected (HTTP 400)", res.status === 400, data);
    check(
      "prestaged: error explains unrelated staged files",
      typeof data.error === "string" && /staged|pre-staged\.txt/i.test(data.error),
      data
    );
    const prestagedLog = git(dir, ["log", "-1", "--pretty=format:%s"]);
    check("prestaged: no commit landed", prestagedLog.trim() === "initial commit", prestagedLog);
    const stat = git(dir, ["status", "--porcelain"]).trim();
    check("prestaged: pre-staged file remains staged", /^A\s+pre-staged\.txt/m.test(stat), stat);
    check("prestaged: included file remains untracked", /\?\?\s+included\.txt/m.test(stat), stat);

    runner.child.kill();
  }

  // ── 6. Existing endpoints still respond ───────────────────────────────────
  {
    const dir = initRepo("adb-runner-commit-regress-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "keep.txt"), "keep me\n", "utf8");
    git(dir, ["add", "keep.txt"]);
    git(dir, ["commit", "-m", "seed"]);

    const runner = await startRunner(dir);
    later(() => runner.child.kill());

    const health = await get(runner.port, runner.token, "/health");
    check("regression: /health ok", health.res.status === 200 && health.data.ok === true, health.data);

    const status = await get(runner.port, runner.token, "/repo/status");
    check("regression: /repo/status ok", status.res.status === 200 && status.data.isRepo === true, status.data);

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
