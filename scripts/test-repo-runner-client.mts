/** Repo runner client wrappers (run: npx tsx scripts/test-repo-runner-client.mts) */
import {
  createIssueViaRunner,
  createMilestoneViaRunner,
  getRepoStatusViaRunner,
  getRepoDiffViaRunner,
  listIssuesViaRunner,
} from "../lib/client/repo-runner";
import { callMcpTool, type RunnerConfig } from "../lib/client/runner";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const config: RunnerConfig = { url: "http://127.0.0.1:8787/", token: "secret-token" };

interface MockCall {
  url: string;
  init: RequestInit | undefined;
}
const calls: MockCall[] = [];
const realFetch = globalThis.fetch;

/** Install a fetch mock that returns the given status + JSON body. */
function mockFetch(status: number, body: unknown) {
  calls.length = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

const headerValue = (init: RequestInit | undefined, name: string): string | undefined => {
  const h = init?.headers as Record<string, string> | undefined;
  return h?.[name];
};

async function main() {
  // 0. Successful /mcp/call parses MCP text/error/truncation fields.
  mockFetch(200, {
    ok: true,
    text: "mcp payload",
    isError: true,
    truncated: true,
  });
  const mcpResult = await callMcpTool(config, "playwright", "snapshot", {
    depth: 1,
  });
  check("mcp-call: text parsed", mcpResult.text === "mcp payload", mcpResult);
  check("mcp-call: isError parsed", mcpResult.isError === true, mcpResult);
  check("mcp-call: truncated parsed", mcpResult.truncated === true, mcpResult);
  check(
    "mcp-call: hit /mcp/call with single slash",
    calls[0]?.url === "http://127.0.0.1:8787/mcp/call",
    calls[0]?.url
  );
  check(
    "mcp-call: sent tool args",
    JSON.parse(String(calls[0]?.init?.body)).args.depth === 1,
    calls[0]?.init?.body
  );

  // 1. Successful /repo/status → parsed RepoStatus fields.
  mockFetch(200, {
    ok: true,
    isRepo: true,
    root: "/home/user/project",
    currentBranch: "main",
    defaultBranch: "main",
    remotes: [{ name: "origin", url: "git@example.com:me/repo.git" }],
    upstream: "origin/main",
    ahead: 1,
    behind: 2,
    staged: ["a.ts"],
    unstaged: ["b.ts"],
    untracked: ["c.ts"],
    conflicted: [],
    clean: false,
    recentCommits: [{ hash: "abc1234", subject: "feat: thing" }],
    gitAvailable: true,
  });
  const status = await getRepoStatusViaRunner(config);
  check("status: returns non-null", status !== null, status);
  check("status: isRepo parsed", status?.isRepo === true, status);
  check("status: root parsed", status?.root === "/home/user/project", status);
  check("status: currentBranch parsed", status?.currentBranch === "main", status);
  check("status: defaultBranch parsed", status?.defaultBranch === "main", status);
  check("status: upstream parsed", status?.upstream === "origin/main", status);
  check("status: ahead/behind parsed", status?.ahead === 1 && status?.behind === 2, status);
  check(
    "status: remotes parsed",
    status?.remotes.length === 1 &&
      status.remotes[0].name === "origin" &&
      status.remotes[0].url === "git@example.com:me/repo.git",
    status
  );
  check(
    "status: file lists parsed",
    Array.isArray(status?.staged) &&
      status?.staged[0] === "a.ts" &&
      status.unstaged[0] === "b.ts" &&
      status.untracked[0] === "c.ts" &&
      Array.isArray(status.conflicted) &&
      status.conflicted.length === 0,
    status
  );
  check("status: clean parsed", status?.clean === false, status);
  check(
    "status: recentCommits parsed",
    status?.recentCommits.length === 1 &&
      status.recentCommits[0].hash === "abc1234" &&
      status.recentCommits[0].subject === "feat: thing",
    status
  );
  check("status: gitAvailable parsed", status?.gitAvailable === true, status);
  check("status: hit /repo/status with single slash", calls[0]?.url === "http://127.0.0.1:8787/repo/status", calls[0]?.url);
  check(
    "status: sent x-runner-token header",
    headerValue(calls[0]?.init, "x-runner-token") === "secret-token",
    calls[0]?.init
  );

  // 2. Successful /repo/diff → RepoDiffResult.
  mockFetch(200, { ok: true, diff: "diff --git a/x b/x\n+hello", truncated: false, bytes: 25 });
  const diff = await getRepoDiffViaRunner(config, { paths: ["x"], staged: true, stat: false });
  check("diff: returns non-null", diff !== null, diff);
  check("diff: diff text parsed", diff?.diff === "diff --git a/x b/x\n+hello", diff);
  check("diff: truncated parsed", diff?.truncated === false, diff);
  check("diff: bytes parsed", diff?.bytes === 25, diff);
  check("diff: hit /repo/diff with single slash", calls[0]?.url === "http://127.0.0.1:8787/repo/diff", calls[0]?.url);
  check("diff: POST method", calls[0]?.init?.method === "POST", calls[0]?.init);
  check(
    "diff: sent x-runner-token header",
    headerValue(calls[0]?.init, "x-runner-token") === "secret-token",
    calls[0]?.init
  );
  check(
    "diff: sent input in body",
    JSON.parse(String(calls[0]?.init?.body)).staged === true,
    calls[0]?.init?.body
  );

  // 3. GitHub planning wrappers parse payloads and post expected bodies.
  mockFetch(200, {
    ok: true,
    repo: "acme/widget",
    issues: [
      {
        number: 11,
        title: "Tagged work",
        body: "body",
        url: "https://github.com/acme/widget/issues/11",
        labels: ["aiboard"],
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
  });
  const issues = await listIssuesViaRunner(config, {
    repo: "acme/widget",
    labels: ["aiboard"],
    limit: 5,
  });
  check("issue-list: returns non-null", issues !== null, issues);
  check("issue-list: issue parsed", issues?.issues[0]?.number === 11, issues);
  check("issue-list: label parsed", issues?.issues[0]?.labels[0] === "aiboard", issues);
  check("issue-list: hit endpoint", calls[0]?.url === "http://127.0.0.1:8787/repo/issue-list", calls[0]?.url);
  check("issue-list: sent labels", JSON.parse(String(calls[0]?.init?.body)).labels[0] === "aiboard", calls[0]?.init?.body);

  mockFetch(200, {
    ok: true,
    repo: "acme/widget",
    title: "Games: Chess",
    number: 5,
    url: "https://github.com/acme/widget/milestone/5",
    created: true,
  });
  const milestone = await createMilestoneViaRunner(config, {
    repo: "acme/widget",
    title: "Games: Chess",
    description: "Plan",
  });
  check("milestone-create: title parsed", milestone?.title === "Games: Chess", milestone);
  check("milestone-create: created parsed", milestone?.created === true, milestone);
  check("milestone-create: hit endpoint", calls[0]?.url === "http://127.0.0.1:8787/repo/milestone-create", calls[0]?.url);

  mockFetch(200, {
    ok: true,
    repo: "acme/widget",
    issue: 12,
    title: "Add chess board",
    url: "https://github.com/acme/widget/issues/12",
  });
  const createdIssue = await createIssueViaRunner(config, {
    repo: "acme/widget",
    title: "Add chess board",
    body: "Implement it",
    milestone: "Games: Chess",
    labels: ["aiboard"],
  });
  check("issue-create: issue parsed", createdIssue?.issue === 12, createdIssue);
  check("issue-create: title parsed", createdIssue?.title === "Add chess board", createdIssue);
  check("issue-create: hit endpoint", calls[0]?.url === "http://127.0.0.1:8787/repo/issue-create", calls[0]?.url);
  check("issue-create: sent milestone", JSON.parse(String(calls[0]?.init?.body)).milestone === "Games: Chess", calls[0]?.init?.body);

  // 3. HTTP 404 (old runner) → null for both wrappers.
  mockFetch(404, { error: "Not found" });
  check("status: 404 → null", (await getRepoStatusViaRunner(config)) === null);
  mockFetch(404, { error: "Not found" });
  check("diff: 404 → null", (await getRepoDiffViaRunner(config)) === null);

  // 4. Network failure → null for both wrappers.
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  check("status: network error → null", (await getRepoStatusViaRunner(config)) === null);
  check("diff: network error → null", (await getRepoDiffViaRunner(config)) === null);

  // 5. /repo/diff 400 validation error → throw with runner's message.
  mockFetch(400, { error: "Unsafe path: ../../etc/passwd" });
  let threw = false;
  let message = "";
  try {
    await getRepoDiffViaRunner(config, { paths: ["../../etc/passwd"] });
  } catch (err) {
    threw = true;
    message = err instanceof Error ? err.message : String(err);
  }
  check("diff: 400 throws", threw, message);
  check("diff: 400 surfaces runner error message", message.includes("Unsafe path"), message);

  restoreFetch();
  console.log(failed === 0 ? "\nAll repo-runner-client checks passed." : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
