/**
 * Runner GitHub-workflow checks (NRW-007).
 * Run: npx tsx scripts/test-runner-github-workflow.mts
 *
 * NO test here hits the network or touches the real `gh`. A fake `gh` is
 * injected via the runner's AIBOARD_GH_CMD seam: the runner spawns the REAL
 * `node` binary (guaranteed cross-platform executable) against a small canned
 * script we write to a temp file. `/repo/push` uses real git against a LOCAL
 * bare remote — also no network.
 */
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

/**
 * Start the runner against `dir`. When `ghCmd` is provided, inject it via
 * AIBOARD_GH_CMD so the runner spawns our fake `gh`; `ghLogPath`, when set, is
 * passed through as AIBOARD_GH_LOG so the fake can append its received argv.
 */
async function startRunner(
  dir: string,
  opts: { ghCmd?: string[]; ghLogPath?: string } = {}
) {
  const port = 19_600 + Math.floor(Math.random() * 1_000);
  const token = "test-token";
  let log = "";
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.ghCmd) env.AIBOARD_GH_CMD = JSON.stringify(opts.ghCmd);
  if (opts.ghLogPath) env.AIBOARD_GH_LOG = opts.ghLogPath;
  const child = spawn(
    process.execPath,
    ["scripts/runner.mjs", dir, "--port", String(port), "--token", token],
    { cwd: process.cwd(), windowsHide: true, env }
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

/**
 * A fake `gh` that:
 *   --version            → prints a version, exit 0 (available)
 *   auth status          → prints a logged-in message, exit 0 (authenticated)
 *   issue view N --repo R --json … → prints canned issue JSON
 *   pr create …          → appends received argv (JSON) to AIBOARD_GH_LOG, then
 *                          prints a canned PR URL
 * Spawned as `node <thisfile>` so it runs on Windows without a .cmd shim.
 */
const FAKE_GH_AUTHED = `
const args = process.argv.slice(2);
const fs = require("node:fs");
function out(s) { process.stdout.write(s); }
if (args[0] === "--version") {
  out("gh version 2.50.0 (fake)\\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  // gh prints auth info on stderr in real life; cover that path.
  process.stderr.write("github.com\\n  Logged in to github.com account octocat (oauth_token)\\n");
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "view") {
  out(JSON.stringify({
    title: "Fix the thing",
    body: "The thing is broken.",
    url: "https://github.com/acme/widget/issues/" + args[2],
    comments: [
      { author: { login: "alice" }, body: "I can repro", createdAt: "2026-01-01T00:00:00Z" },
      { author: { login: "bob" }, body: "Same here", createdAt: "2026-01-02T00:00:00Z" },
    ],
  }));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "list") {
  out(JSON.stringify([
    {
      number: 11,
      title: "Tagged work",
      body: "Please handle #aiboard chess setup.",
      url: "https://github.com/acme/widget/issues/11",
      updatedAt: "2026-01-03T00:00:00Z",
      labels: [{ name: "aiboard" }],
    },
  ]));
  process.exit(0);
}
if (args[0] === "api" && args.includes("GET") && args.some((a) => /\\/milestones(\\?|$)/.test(a))) {
  out(JSON.stringify([]));
  process.exit(0);
}
if (args[0] === "api" && /\\/milestones$/.test(args[1]) && args.includes("-X") && args.includes("POST")) {
  out(JSON.stringify({
    title: "Games: Chess",
    number: 5,
    html_url: "https://github.com/acme/widget/milestone/5",
  }));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "create") {
  const logPath = process.env.AIBOARD_GH_LOG;
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
  const li = args.indexOf("--label");
  if (li !== -1 && args[li + 1] === "missinglabel") {
    process.stderr.write("could not add label: 'missinglabel' not found\\n");
    process.exit(1);
  }
  out("https://github.com/acme/widget/issues/12\\n");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  const logPath = process.env.AIBOARD_GH_LOG;
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
  out("https://github.com/acme/widget/pull/42\\n");
  process.exit(0);
}
process.stderr.write("fake gh: unhandled args " + JSON.stringify(args) + "\\n");
process.exit(1);
`;

/** A fake `gh` whose `--version` fails — simulates gh not being installed. */
const FAKE_GH_UNAVAILABLE = `
process.stderr.write("not found\\n");
process.exit(1);
`;

/** A fake `gh` that is installed (--version ok) but NOT authenticated. */
const FAKE_GH_UNAUTH = `
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("gh version 2.50.0 (fake)\\n"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") {
  process.stderr.write("You are not logged into any GitHub hosts.\\n");
  process.exit(1);
}
process.exit(1);
`;

function writeFakeGh(prefix: string, source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  later(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fake-gh.cjs");
  fs.writeFileSync(file, source, "utf8");
  return file;
}

try {
  // ── 1. gh available + authenticated → /repo/status reports it ──────────────
  {
    const dir = initRepo("adb-gh-status-authed-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "README.txt"), "hi\n", "utf8");
    git(dir, ["add", "README.txt"]);
    git(dir, ["commit", "-m", "seed"]);

    const fake = writeFakeGh("adb-gh-authed-", FAKE_GH_AUTHED);
    const runner = await startRunner(dir, { ghCmd: [process.execPath, fake] });
    later(() => runner.child.kill());

    const { res, data } = await get(runner.port, runner.token, "/repo/status");
    check("status(authed): HTTP 200", res.status === 200, data);
    check("status(authed): githubCli.available true", data.githubCli?.available === true, data.githubCli);
    check("status(authed): githubCli.authenticated true", data.githubCli?.authenticated === true, data.githubCli);
    check("status(authed): parsed user 'octocat'", data.githubCli?.user === "octocat", data.githubCli);
    check("status(authed): still reports repo info", data.isRepo === true && data.clean === true, data);
    runner.child.kill();
  }

  // ── 2. gh installed but NOT authenticated ─────────────────────────────────
  {
    const dir = initRepo("adb-gh-status-unauth-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fake = writeFakeGh("adb-gh-unauth-", FAKE_GH_UNAUTH);
    const runner = await startRunner(dir, { ghCmd: [process.execPath, fake] });
    later(() => runner.child.kill());

    const { res, data } = await get(runner.port, runner.token, "/repo/status");
    check("status(unauth): HTTP 200", res.status === 200, data);
    check("status(unauth): available true", data.githubCli?.available === true, data.githubCli);
    check("status(unauth): authenticated false", data.githubCli?.authenticated === false, data.githubCli);
    check("status(unauth): user null", data.githubCli?.user === null, data.githubCli);
    runner.child.kill();
  }

  // ── 3. gh UNAVAILABLE → /repo/status STILL succeeds (acceptance criterion) ─
  {
    const dir = initRepo("adb-gh-status-absent-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fake = writeFakeGh("adb-gh-absent-", FAKE_GH_UNAVAILABLE);
    const runner = await startRunner(dir, { ghCmd: [process.execPath, fake] });
    later(() => runner.child.kill());

    const { res, data } = await get(runner.port, runner.token, "/repo/status");
    check("status(absent): HTTP 200 (does NOT fail when gh missing)", res.status === 200, data);
    check("status(absent): available false", data.githubCli?.available === false, data.githubCli);
    check("status(absent): authenticated false", data.githubCli?.authenticated === false, data.githubCli);
    check("status(absent): user null", data.githubCli?.user === null, data.githubCli);
    check("status(absent): git info intact", data.gitAvailable === true && data.isRepo === true, data);
    runner.child.kill();
  }

  // ── 3b. node runs but the fake script is missing (exit 1, not ENOENT) ─────
  // Inject a node-running script path that does not exist → spawnSync of node
  // succeeds but the script fails (exit 1) → available:false. Covers the
  // "AIBOARD_GH_CMD points at a missing module" path without a real gh.
  {
    const dir = initRepo("adb-gh-status-missing-script-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    const missing = path.join(os.tmpdir(), "adb-no-such-fake-gh-" + Date.now() + ".cjs");
    const runner = await startRunner(dir, { ghCmd: [process.execPath, missing] });
    later(() => runner.child.kill());
    const { res, data } = await get(runner.port, runner.token, "/repo/status");
    check("status(missing-script): HTTP 200", res.status === 200, data);
    check("status(missing-script): available false", data.githubCli?.available === false, data.githubCli);
    runner.child.kill();
  }

  // ── 3c. true spawn ENOENT: the gh binary itself can't be found ────────────
  // AIBOARD_GH_CMD points at a non-existent EXECUTABLE (not node), so
  // spawnSync("definitely-not-a-real-binary-xyz123") fails with ENOENT →
  // runGh returns exitCode:-1 + spawnError. Exercises the genuine runGh
  // spawn-error branch (not just a script that exits 1).
  {
    const dir = initRepo("adb-gh-status-enoent-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    const runner = await startRunner(dir, { ghCmd: ["definitely-not-a-real-binary-xyz123"] });
    later(() => runner.child.kill());
    const { res, data } = await get(runner.port, runner.token, "/repo/status");
    check("status(enoent): HTTP 200 (does NOT fail on spawn ENOENT)", res.status === 200, data);
    check("status(enoent): available false", data.githubCli?.available === false, data.githubCli);
    check("status(enoent): authenticated false", data.githubCli?.authenticated === false, data.githubCli);
    check("status(enoent): git info intact", data.gitAvailable === true && data.isRepo === true, data);
    runner.child.kill();
  }

  // ── 4. /repo/issue-read returns structured issue data ─────────────────────
  {
    const dir = initRepo("adb-gh-issue-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fake = writeFakeGh("adb-gh-issue-fake-", FAKE_GH_AUTHED);
    const runner = await startRunner(dir, { ghCmd: [process.execPath, fake] });
    later(() => runner.child.kill());

    const { res, data } = await post(runner.port, runner.token, "/repo/issue-read", {
      repo: "acme/widget",
      issue: 7,
    });
    check("issue-read: HTTP 200", res.status === 200, data);
    check("issue-read: repo echoed", data.repo === "acme/widget", data);
    check("issue-read: issue echoed", data.issue === 7, data);
    check("issue-read: title parsed", data.title === "Fix the thing", data);
    check("issue-read: body parsed", data.body === "The thing is broken.", data);
    check("issue-read: url parsed (includes issue number)", data.url === "https://github.com/acme/widget/issues/7", data);
    check("issue-read: 2 comments mapped", Array.isArray(data.comments) && data.comments.length === 2, data);
    check(
      "issue-read: comment author flattened from author.login",
      data.comments?.[0]?.author === "alice" && data.comments?.[1]?.author === "bob",
      data.comments
    );
    check(
      "issue-read: comment body + createdAt present",
      data.comments?.[0]?.body === "I can repro" && data.comments?.[0]?.createdAt === "2026-01-01T00:00:00Z",
      data.comments
    );

    // Validation (no gh needed): bad repo format and non-positive issue.
    const badRepo = await post(runner.port, runner.token, "/repo/issue-read", { repo: "not-a-slug", issue: 1 });
    check("issue-read: rejects bad repo (HTTP 400)", badRepo.res.status === 400 && !!badRepo.data.error, badRepo.data);
    const badIssue = await post(runner.port, runner.token, "/repo/issue-read", { repo: "acme/widget", issue: 0 });
    check("issue-read: rejects non-positive issue (HTTP 400)", badIssue.res.status === 400 && !!badIssue.data.error, badIssue.data);
    const negIssue = await post(runner.port, runner.token, "/repo/issue-read", { repo: "acme/widget", issue: -3 });
    check("issue-read: rejects negative issue (HTTP 400)", negIssue.res.status === 400 && !!negIssue.data.error, negIssue.data);
    const floatIssue = await post(runner.port, runner.token, "/repo/issue-read", { repo: "acme/widget", issue: 1.5 });
    check("issue-read: rejects non-integer issue (HTTP 400)", floatIssue.res.status === 400 && !!floatIssue.data.error, floatIssue.data);
    runner.child.kill();
  }

  // ── 4b. issue-read when gh is unavailable → 502 (upstream), not a crash ────
  {
    const dir = initRepo("adb-gh-issue-absent-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fake = writeFakeGh("adb-gh-issue-absent-fake-", FAKE_GH_UNAVAILABLE);
    const runner = await startRunner(dir, { ghCmd: [process.execPath, fake] });
    later(() => runner.child.kill());
    const { res, data } = await post(runner.port, runner.token, "/repo/issue-read", { repo: "acme/widget", issue: 1 });
    check("issue-read(absent): HTTP 502 (gh failure, not 200/crash)", res.status === 502 && !!data.error, data);
    runner.child.kill();
  }

  // ── 4c. issue list / milestone create / issue create use gh with explicit argv ─
  {
    const dir = initRepo("adb-gh-planning-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "adb-gh-planning-log-"));
    later(() => fs.rmSync(logDir, { recursive: true, force: true }));
    const logPath = path.join(logDir, "gh-argv.log");
    const fake = writeFakeGh("adb-gh-planning-fake-", FAKE_GH_AUTHED);
    const runner = await startRunner(dir, { ghCmd: [process.execPath, fake], ghLogPath: logPath });
    later(() => runner.child.kill());

    const listed = await post(runner.port, runner.token, "/repo/issue-list", {
      repo: "acme/widget",
      labels: ["aiboard"],
      limit: 5,
    });
    check("issue-list: HTTP 200", listed.res.status === 200, listed.data);
    check("issue-list: returns open issue", listed.data.issues?.[0]?.number === 11, listed.data);
    check("issue-list: maps label names", listed.data.issues?.[0]?.labels?.[0] === "aiboard", listed.data);

    const milestone = await post(runner.port, runner.token, "/repo/milestone-create", {
      repo: "acme/widget",
      title: "Games: Chess",
      description: "Plan chess delivery",
    });
    check("milestone-create: HTTP 200", milestone.res.status === 200, milestone.data);
    check("milestone-create: returns milestone number", milestone.data.number === 5, milestone.data);
    check("milestone-create: created true", milestone.data.created === true, milestone.data);

    const issue = await post(runner.port, runner.token, "/repo/issue-create", {
      repo: "acme/widget",
      title: "Add chess board",
      body: "Implement the board",
      milestone: "Games: Chess",
      labels: ["aiboard"],
    });
    check("issue-create: HTTP 200", issue.res.status === 200, issue.data);
    check("issue-create: parses issue number from URL", issue.data.issue === 12, issue.data);
    check("issue-create: echoes title", issue.data.title === "Add chess board", issue.data);

    const logged = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    const issueCreateArgv = logged.find((argv) => argv[0] === "issue" && argv[1] === "create") ?? [];
    const argAfter = (flag: string) => issueCreateArgv[issueCreateArgv.indexOf(flag) + 1];
    check("issue-create: argv has --repo", argAfter("--repo") === "acme/widget", issueCreateArgv);
    check("issue-create: argv has --milestone", argAfter("--milestone") === "Games: Chess", issueCreateArgv);
    check("issue-create: argv has --label", argAfter("--label") === "aiboard", issueCreateArgv);

    // Label resilience: a model-invented label that doesn't exist must NOT lose
    // the issue — the runner retries once without labels and still creates it.
    const labelRetry = await post(runner.port, runner.token, "/repo/issue-create", {
      repo: "acme/widget",
      title: "Issue with a bad label",
      body: "",
      labels: ["missinglabel"],
    });
    check(
      "issue-create: bad label still creates the issue (retry without labels)",
      labelRetry.res.status === 200 && labelRetry.data.issue === 12,
      labelRetry.data
    );
    const retryArgvs = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[])
      .filter((argv) => argv[0] === "issue" && argv[1] === "create" && argv.includes("Issue with a bad label"));
    check(
      "issue-create: retried exactly once without labels",
      retryArgvs.length === 2 && !retryArgvs[1].includes("--label"),
      retryArgvs
    );

    const badMilestone = await post(runner.port, runner.token, "/repo/milestone-create", {
      repo: "acme/widget",
      title: " ",
    });
    check("milestone-create: rejects empty title (HTTP 400)", badMilestone.res.status === 400 && !!badMilestone.data.error, badMilestone.data);
    const badIssue = await post(runner.port, runner.token, "/repo/issue-create", {
      repo: "bad slug",
      title: "x",
      body: "",
    });
    check("issue-create: rejects bad repo (HTTP 400)", badIssue.res.status === 400 && !!badIssue.data.error, badIssue.data);
    runner.child.kill();
  }

  // ── 5. /repo/pr-create returns the URL and passes the expected argv ────────
  {
    const dir = initRepo("adb-gh-pr-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "adb-gh-pr-log-"));
    later(() => fs.rmSync(logDir, { recursive: true, force: true }));
    const logPath = path.join(logDir, "gh-argv.log");
    const fake = writeFakeGh("adb-gh-pr-fake-", FAKE_GH_AUTHED);
    const runner = await startRunner(dir, { ghCmd: [process.execPath, fake], ghLogPath: logPath });
    later(() => runner.child.kill());

    const { res, data } = await post(runner.port, runner.token, "/repo/pr-create", {
      repo: "acme/widget",
      title: "Add a feature",
      body: "This PR adds a feature.",
      base: "main",
      head: "codex/add-feature",
      draft: true,
    });
    check("pr-create: HTTP 200", res.status === 200, data);
    check("pr-create: returns the parsed PR URL", data.url === "https://github.com/acme/widget/pull/42", data);
    check("pr-create: echoes title", data.title === "Add a feature", data);
    check("pr-create: echoes base/head/draft", data.base === "main" && data.head === "codex/add-feature" && data.draft === true, data);

    // Inspect the argv the fake gh actually received.
    const logged = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    const argv = logged[logged.length - 1];
    check("pr-create: argv begins with `pr create`", argv[0] === "pr" && argv[1] === "create", argv);
    const hasFlag = (flag: string, value?: string) => {
      const i = argv.indexOf(flag);
      if (i < 0) return false;
      return value === undefined ? true : argv[i + 1] === value;
    };
    check("pr-create: argv has --title <title>", hasFlag("--title", "Add a feature"), argv);
    check("pr-create: argv has --body <body>", hasFlag("--body", "This PR adds a feature."), argv);
    check("pr-create: argv has --repo acme/widget", hasFlag("--repo", "acme/widget"), argv);
    check("pr-create: argv has --base main", hasFlag("--base", "main"), argv);
    check("pr-create: argv has --head codex/add-feature", hasFlag("--head", "codex/add-feature"), argv);
    check("pr-create: argv has --draft (no value)", hasFlag("--draft"), argv);

    // Non-draft, minimal args → no --draft / --repo / --base / --head flags.
    const minimal = await post(runner.port, runner.token, "/repo/pr-create", {
      title: "Minimal PR",
      body: "",
    });
    check("pr-create(minimal): HTTP 200", minimal.res.status === 200, minimal.data);
    const logged2 = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    const argv2 = logged2[logged2.length - 1];
    check("pr-create(minimal): no --draft", !argv2.includes("--draft"), argv2);
    check("pr-create(minimal): no --repo/--base/--head", !argv2.includes("--repo") && !argv2.includes("--base") && !argv2.includes("--head"), argv2);

    // Space-padded refs are accepted (validators trim) and TRIMMED before argv.
    const padded = await post(runner.port, runner.token, "/repo/pr-create", {
      repo: "  acme/widget  ",
      title: "Padded PR",
      body: "x",
      base: " main ",
      head: " codex/x ",
    });
    check("pr-create(padded): HTTP 200", padded.res.status === 200, padded.data);
    check("pr-create(padded): echoes TRIMMED base/head", padded.data.base === "main" && padded.data.head === "codex/x", padded.data);
    const logged3 = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    const argv3 = logged3[logged3.length - 1];
    const at = (flag: string) => argv3[argv3.indexOf(flag) + 1];
    check(
      "pr-create(padded): argv carries trimmed repo/base/head (no padding)",
      at("--repo") === "acme/widget" && at("--base") === "main" && at("--head") === "codex/x",
      argv3
    );

    // Validation (no gh needed).
    const emptyTitle = await post(runner.port, runner.token, "/repo/pr-create", { title: "  ", body: "x" });
    check("pr-create: rejects empty title (HTTP 400)", emptyTitle.res.status === 400 && !!emptyTitle.data.error, emptyTitle.data);
    const longTitle = await post(runner.port, runner.token, "/repo/pr-create", { title: "a".repeat(201), body: "x" });
    check("pr-create: rejects >200 char title (HTTP 400)", longTitle.res.status === 400 && !!longTitle.data.error, longTitle.data);
    const bigBody = await post(runner.port, runner.token, "/repo/pr-create", { title: "ok", body: "x".repeat(20 * 1024 + 1) });
    check("pr-create: rejects oversized body (HTTP 400)", bigBody.res.status === 400 && !!bigBody.data.error, bigBody.data);
    const badBase = await post(runner.port, runner.token, "/repo/pr-create", { title: "ok", body: "x", base: "-bad" });
    check("pr-create: rejects bad base ref (HTTP 400)", badBase.res.status === 400 && !!badBase.data.error, badBase.data);
    const badHead = await post(runner.port, runner.token, "/repo/pr-create", { title: "ok", body: "x", head: "a..b" });
    check("pr-create: rejects bad head ref (HTTP 400)", badHead.res.status === 400 && !!badHead.data.error, badHead.data);
    const badRepo = await post(runner.port, runner.token, "/repo/pr-create", { title: "ok", body: "x", repo: "bad slug" });
    check("pr-create: rejects bad repo (HTTP 400)", badRepo.res.status === 400 && !!badRepo.data.error, badRepo.data);
    runner.child.kill();
  }

  // ── 6. /repo/push — real git, LOCAL bare remote, no network ───────────────
  {
    const dir = initRepo("adb-gh-push-");
    later(() => fs.rmSync(dir, { recursive: true, force: true }));

    // A bare repo acts as the "remote" entirely on local disk.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "adb-gh-push-bare-"));
    later(() => fs.rmSync(bare, { recursive: true, force: true }));
    git(bare, ["init", "--bare"]);

    fs.writeFileSync(path.join(dir, "file.txt"), "content\n", "utf8");
    git(dir, ["add", "file.txt"]);
    git(dir, ["commit", "-m", "initial"]);
    git(dir, ["remote", "add", "origin", bare]);
    const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();

    // No gh injection needed — push is pure git.
    const runner = await startRunner(dir);
    later(() => runner.child.kill());

    const { res, data } = await post(runner.port, runner.token, "/repo/push", {
      branch,
      setUpstream: true,
    });
    check("push: HTTP 200", res.status === 200, data);
    check("push: remote defaults to origin", data.remote === "origin", data);
    check("push: branch echoed", data.branch === branch, data);
    check("push: setUpstream true", data.setUpstream === true, data);

    // Upstream is now set locally.
    const upstream = spawnSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      cwd: dir,
      encoding: "utf8",
    });
    check("push: upstream tracking set to origin/<branch>", upstream.status === 0 && upstream.stdout.trim() === `origin/${branch}`, upstream.stdout || upstream.stderr);

    // The bare remote actually received the branch ref.
    const remoteRef = spawnSync("git", ["--git-dir", bare, "rev-parse", "--verify", `refs/heads/${branch}`], {
      cwd: bare,
      encoding: "utf8",
    });
    check("push: bare remote has the pushed branch", remoteRef.status === 0 && remoteRef.stdout.trim().length === 40, remoteRef.stdout || remoteRef.stderr);

    // Space-padded branch/remote are accepted (validators trim) and used trimmed:
    // a padded " <branch> " must push to the SAME ref, not a padded one.
    git(dir, ["checkout", "-b", "padded-branch"]);
    const paddedPush = await post(runner.port, runner.token, "/repo/push", {
      remote: " origin ",
      branch: " padded-branch ",
    });
    check("push(padded): HTTP 200", paddedPush.res.status === 200, paddedPush.data);
    check("push(padded): echoes TRIMMED remote/branch", paddedPush.data.remote === "origin" && paddedPush.data.branch === "padded-branch", paddedPush.data);
    const paddedRef = spawnSync("git", ["--git-dir", bare, "rev-parse", "--verify", "refs/heads/padded-branch"], {
      cwd: bare,
      encoding: "utf8",
    });
    check("push(padded): bare remote got 'padded-branch' (not space-padded)", paddedRef.status === 0, paddedRef.stdout || paddedRef.stderr);
    git(dir, ["checkout", branch]);

    // Push validation (no network): bad branch + bad remote.
    const badBranch = await post(runner.port, runner.token, "/repo/push", { branch: "-evil" });
    check("push: rejects bad branch (HTTP 400)", badBranch.res.status === 400 && !!badBranch.data.error, badBranch.data);
    const badRemote = await post(runner.port, runner.token, "/repo/push", { remote: "-bad", branch });
    check("push: rejects leading-dash remote (HTTP 400)", badRemote.res.status === 400 && !!badRemote.data.error, badRemote.data);
    const spaceRemote = await post(runner.port, runner.token, "/repo/push", { remote: "or igin", branch });
    check("push: rejects remote with space (HTTP 400)", spaceRemote.res.status === 400 && !!spaceRemote.data.error, spaceRemote.data);
    runner.child.kill();
  }

  // ── 7. non-repo push → 400 (not a crash); status still ok ─────────────────
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adb-gh-push-norepo-"));
    later(() => fs.rmSync(dir, { recursive: true, force: true }));
    const runner = await startRunner(dir);
    later(() => runner.child.kill());
    const { res, data } = await post(runner.port, runner.token, "/repo/push", { branch: "main" });
    check("push(non-repo): HTTP 400 with error", res.status === 400 && !!data.error, data);
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
