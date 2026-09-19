import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { enforceGitRepositoryExecutionPolicy, prepareGitExecutionPolicy } from "../src/git-execution-policy.js";

async function withRepository<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "aiboard-git-policy-"));
  await mkdir(join(root, ".git", "info"), { recursive: true });
  await writeFile(join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n", "utf8");
  let failed = false;
  try { return await body(root); }
  catch (error) { failed = true; throw error; }
  finally { if (!failed) await rm(root, { recursive: true, force: true }); }
}

async function prepare(root: string, args: readonly string[] = ["status"], env?: Readonly<Record<string, string | undefined>>) {
  const prepared = prepareGitExecutionPolicy({ cwd: root, args, ...(env ? { env } : {}) }, "win32");
  await enforceGitRepositoryExecutionPolicy(root);
  return prepared;
}

async function rejectsPolicy(operation: () => unknown | Promise<unknown>): Promise<void> {
  await assert.rejects(Promise.resolve().then(operation), (error: unknown) =>
    error instanceof Error && error.name === "GitCommandError" &&
    String((error as { code?: unknown }).code) === "policy_refused" &&
    /Git execution policy refused/i.test(error.message));
}

test("Git policy installs the complete safe config/environment baseline", async () => {
  await withRepository(async (root) => {
    const prepared = await prepare(root, ["status"], {
      GIT_AUTHOR_NAME: "Runner",
      GIT_INDEX_FILE: join(root, ".git", "task.index"),
    });
    for (const entry of [
      "core.hooksPath=", "core.fsmonitor=false", "credential.helper=",
      "core.askPass=", "core.editor=", "core.attributesFile=", "commit.gpgSign=false",
      "merge.gpgSign=false", "tag.gpgSign=false", "log.showSignature=false",
    ]) assert.equal(prepared.arguments.includes(entry), true, entry);
    assert.equal(prepared.arguments.includes("diff.external="), false);
    assert.equal(prepared.arguments[0], "--no-pager");
    assert.equal(prepared.environment.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(prepared.environment.GIT_CONFIG_GLOBAL, "NUL");
    assert.equal(prepared.environment.GIT_TERMINAL_PROMPT, "0");
    assert.equal(prepared.environment.GIT_DIR, undefined);
    assert.equal(prepared.environment.GIT_SSH_COMMAND, undefined);
    assert.equal(prepared.environment.GIT_AUTHOR_NAME, "Runner");
  });
});

test("Git policy preserves existing Runner command shapes including remotes, push and log patch output", async () => {
  await withRepository(async (root) => {
    for (const args of [
      ["remote"],
      ["remote", "get-url", "origin"],
      ["remote", "get-url", "--push", "origin"],
      ["push", "origin", "HEAD:refs/heads/result"],
      ["log", "-p", "-1"],
    ] as const) {
      const prepared = await prepare(root, args);
      assert.deepEqual(prepared.arguments.slice(-args.length), args);
    }
  });
});

test("Git policy refuses argv policy replacement, unsupported commands and mutating remote configuration", async () => {
  await withRepository(async (root) => {
    for (const args of [
      ["-c", "core.hooksPath=/tmp/evil", "status"],
      ["--config-env=core.hooksPath=EVIL", "status"],
      ["--git-dir=.git", "status"],
      ["--work-tree=.", "status"],
      ["--paginate", "status"],
      ["config", "core.hooksPath", "evil"],
      ["evil-alias"],
      ["clone", "https://example.invalid/repo.git"],
      ["fetch", "origin"],
      ["pull"],
      ["submodule", "update", "--init"],
      ["remote", "add", "evil", "ext::helper"],
      ["push", "ext::helper", "HEAD:refs/heads/result"],
    ] as const) await rejectsPolicy(() => prepare(root, args));
  });
});

test("Git policy refuses operations that would require an editor before Git can mutate", async () => {
  await withRepository(async (root) => {
    await rejectsPolicy(() => prepare(root, ["commit"]));
    await rejectsPolicy(() => prepare(root, ["commit", "--amend"]));
    await rejectsPolicy(() => prepare(root, ["commit", "-m", "safe message", "--edit"]));
    await rejectsPolicy(() => prepare(root, ["merge", "--edit", "topic"]));
    await rejectsPolicy(() => prepare(root, ["cherry-pick", "--edit", "deadbeef"]));
    await prepare(root, ["commit", "-m", "safe message"]);
    await prepare(root, ["commit", "--no-edit", "--amend"]);
    await prepare(root, ["merge", "--no-edit", "topic"]);
    await prepare(root, ["cherry-pick", "-x", "deadbeef"]);
  });
});

test("Git policy allows only narrowly enumerated caller Git environment and rejects canonical duplicates", async () => {
  await withRepository(async (root) => {
    await rejectsPolicy(() => prepare(root, ["status"], { GIT_SSH_COMMAND: "evil" }));
    await rejectsPolicy(() => prepare(root, ["status"], { PAGER: "evil" }));
    await rejectsPolicy(() => prepare(root, ["status"], { GIT_AUTHOR_NAME: "one", git_author_name: "two" }));
    const accepted = await prepare(root, ["status"], {
      GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.invalid",
      GIT_COMMITTER_NAME: "C", GIT_COMMITTER_EMAIL: "c@example.invalid",
      GIT_INDEX_FILE: join(root, ".git", "isolated.index"),
    });
    assert.equal(accepted.environment.GIT_AUTHOR_NAME, "A");
    assert.equal(accepted.environment.GIT_INDEX_FILE?.endsWith("isolated.index"), true);
  });
});

const hostileConfigs = [
  ["include.path", "[include]\n\tpath = ../outside.gitconfig\n"],
  ["includeIf", "[includeIf \"gitdir:/**\"]\n\tpath = ../outside.gitconfig\n"],
  ["alias", "[alias]\n\tevil = !helper\n"],
  ["filter.clean", "[filter \"evil\"]\n\tclean = helper\n"],
  ["filter.smudge", "[filter \"evil\"]\n\tsmudge = helper\n"],
  ["filter.process", "[filter \"evil\"]\n\tprocess = helper\n"],
  ["diff.command", "[diff \"evil\"]\n\tcommand = helper\n"],
  ["diff.textconv", "[diff \"evil\"]\n\ttextconv = helper\n"],
  ["diff.external", "[diff]\n\texternal = helper\n"],
  ["merge.driver", "[merge \"evil\"]\n\tdriver = helper %O %A %B\n"],
  ["credential.helper", "[credential]\n\thelper = !helper\n"],
  ["core.sshCommand", "[core]\n\tsshCommand = helper\n"],
  ["core.gitProxy", "[core]\n\tgitProxy = helper\n"],
  ["url rewrite", "[url \"ext::helper\"]\n\tinsteadOf = safe://\n"],
  ["submodule update", "[submodule \"evil\"]\n\tupdate = !helper\n"],
] as const;

test("Git policy refuses repository config capable of selecting indirect programs", async () => {
  for (const [label, fragment] of hostileConfigs) {
    await withRepository(async (root) => {
      await writeFile(join(root, ".git", "config"), `[core]\n\trepositoryformatversion = 0\n${fragment}`, "utf8");
      await rejectsPolicy(() => prepare(root, ["status"]));
    }).catch((error) => { throw new Error(`hostile config ${label} was not refused`, { cause: error }); });
  }
});

test("Git policy refuses dangerous worktree and info attributes, including nested attributes", async () => {
  for (const [relativePath, content] of [
    [".gitattributes", "*.txt filter=evil\n"],
    ["nested/.gitattributes", "*.txt diff=evil\n"],
    [".git/info/attributes", "*.txt merge=evil\n"],
  ] as const) {
    await withRepository(async (root) => {
      await mkdir(join(root, "nested"), { recursive: true });
      await writeFile(join(root, ...relativePath.split("/")), content, "utf8");
      await rejectsPolicy(() => prepare(root, ["status"]));
    });
  }
});

test("Git policy accepts benign repository config and attributes", async () => {
  await withRepository(async (root) => {
    await writeFile(join(root, ".git", "config"), [
      "[core]", "\trepositoryformatversion = 0", "\tbare = false",
      "[remote \"origin\"]", "\turl = https://example.invalid/repo.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*", "",
    ].join("\n"), "utf8");
    await writeFile(join(root, ".gitattributes"), "*.txt text eol=lf\n", "utf8");
    await prepare(root, ["status"]);
    await prepare(root, ["remote", "get-url", "origin"]);
    await prepare(root, ["push", "origin", "HEAD:refs/heads/result"]);
  });
});

test("Git policy refuses repository remote-helper transports selected by config", async () => {
  await withRepository(async (root) => {
    await writeFile(join(root, ".git", "config"), [
      "[core]", "\trepositoryformatversion = 0",
      "[remote \"origin\"]", "\turl = ext::helper --sentinel", "",
    ].join("\n"), "utf8");
    await rejectsPolicy(() => prepare(root, ["push", "origin", "HEAD:refs/heads/result"]));
  });
});