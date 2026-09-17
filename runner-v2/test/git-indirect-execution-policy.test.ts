import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost, type ExecutionHostRunBinding } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { runGit as fixtureGit } from "./support/git-fixture.js";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

const identity = Object.freeze({
  GIT_AUTHOR_NAME: "AIBoard Task9",
  GIT_AUTHOR_EMAIL: "task9@example.invalid",
  GIT_COMMITTER_NAME: "AIBoard Task9",
  GIT_COMMITTER_EMAIL: "task9@example.invalid",
});

function binding(runId: string) {
  return { runId, permissionProfile: "full" as const,
    capabilityContract: { digest: "9".repeat(64) } as RunnerCapabilityContract,
    capabilitiesConfig: emptyRunnerCapabilitiesConfig() };
}

async function withProductionGit(
  name: string,
  body: (input: { root: string; project: string; run: ExecutionHostRunBinding }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `aiboard-task9-${name}-`));
  const project = join(root, "project"), state = join(root, "state");
  await mkdir(project); await mkdir(state);
  console.log(`C5 CLI root: ${JSON.stringify({ event: "created", path: root })}`);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts,
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  let run: ExecutionHostRunBinding | undefined, failed = false, primary: unknown;
  try {
    await fixtureGit({ cwd: project, args: ["init", "-b", "main"] });
    await writeFile(join(project, "tracked.txt"), "one\n");
    await fixtureGit({ cwd: project, args: ["add", "tracked.txt"] });
    await fixtureGit({ cwd: project, args: ["commit", "-m", "initial"], env: identity });
    run = await host.bindRun(binding(`task9-${name}`));
    await body({ root, project, run });
  } catch (error) { failed = true; primary = error; }
  finally {
    await finalizeCertifiedFixture({ fixtureName: `Task9 ${name}`, root, hasPrimaryFailure: failed,
      primaryFailure: primary, cleanup: async () => { await run?.close(); await host.close(); },
      certify: async () => assert.deepEqual(host.activeRunIds(), []),
      removeRoot: async () => { await rm(root, { recursive: true }); console.log(`C5 CLI root: ${JSON.stringify({ event: "exit", path: root, existsAtExit: false })}`); } });
  }
}

test("Task 9 production Git commit never executes a repository-controlled pre-commit hook", async () => {
  await withProductionGit("hook", async ({ root, project, run }) => {
    const sentinel = join(root, "hook-sentinel.txt");
    const hook = join(project, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nprintf hook > ../hook-sentinel.txt\nexit 0\n");
    await chmod(hook, 0o755);
    await writeFile(join(project, "tracked.txt"), "two\n");
    await fixtureGit({ cwd: project, args: ["add", "tracked.txt"] });

    await run.git.lifecycle("workspace").run({
      cwd: project,
      args: ["commit", "-m", "Task9 production hook policy"],
      env: identity,
    });

    assert.equal(existsSync(sentinel), false,
      "production Git must disable repository-controlled hooks before any commit side effect");
  });
});

async function withCallGit<T>(
  run: ExecutionHostRunBinding,
  project: string,
  name: string,
  approvals: { network?: boolean; external?: boolean },
  body: (git: ReturnType<ExecutionHostRunBinding["git"]["forCall"]>) => Promise<T>,
): Promise<T> {
  const context = {
    runId: run.runId,
    sessionId: `task9-${name}-session`,
    actor: { role: "worker" as const, id: `task9-${name}-worker` },
    toolName: `git.task9-${name}`,
    callId: `task9-${name}-call`,
    permissionProfile: "full" as const,
    workspacePath: project,
  };
  const grant = await run.executionGrants.issue({
    ...context,
    access: [{ path: project, mode: "write" }],
    networkApproved: approvals.network ?? false,
    externalApproved: approvals.external ?? false,
    destructiveApproved: false,
  });
  try { return await body(run.git.forCall({ ...context, executionGrant: grant })); }
  finally { await run.executionGrants.revoke(grant, "completed"); }
}

async function expectPolicyRefused(operation: () => Promise<unknown>): Promise<void> {
  await assert.rejects(operation, (error: unknown) =>
    error instanceof Error && error.name === "GitCommandError" &&
    String((error as { code?: unknown }).code) === "policy_refused");
}

async function setConfig(project: string, key: string, value: string): Promise<void> {
  await fixtureGit({ cwd: project, args: ["config", "--local", key, value] });
}

test("Task 9 refuses a repository clean filter before it can run", async () => {
  await withProductionGit("clean-filter", async ({ root, project, run }) => {
    const sentinel = join(root, "clean-sentinel.txt");
    await setConfig(project, "filter.evil.clean", "sh -c 'cat; printf clean > ../clean-sentinel.txt'");
    await writeFile(join(project, ".gitattributes"), "tracked.txt filter=evil\n");
    await writeFile(join(project, "tracked.txt"), "two\n");
    await expectPolicyRefused(() => run.git.lifecycle("workspace").run({ cwd: project, args: ["add", "tracked.txt"] }));
    assert.equal(existsSync(sentinel), false);
  });
});

test("Task 9 refuses a repository smudge filter before it can run", async () => {
  await withProductionGit("smudge-filter", async ({ root, project, run }) => {
    const sentinel = join(root, "smudge-sentinel.txt");
    await setConfig(project, "filter.evil.smudge", "sh -c 'cat; printf smudge > ../smudge-sentinel.txt'");
    await writeFile(join(project, ".gitattributes"), "tracked.txt filter=evil\n");
    await rm(join(project, "tracked.txt"));
    await expectPolicyRefused(() => run.git.lifecycle("workspace").run({ cwd: project, args: ["checkout", "--", "tracked.txt"] }));
    assert.equal(existsSync(sentinel), false);
  });
});

test("Task 9 refuses a repository process filter before it can start", async () => {
  await withProductionGit("process-filter", async ({ root, project, run }) => {
    const sentinel = join(root, "process-sentinel.txt");
    await setConfig(project, "filter.evil.process", "sh -c 'printf process > ../process-sentinel.txt; exit 1'");
    await writeFile(join(project, ".gitattributes"), "tracked.txt filter=evil\n");
    await writeFile(join(project, "tracked.txt"), "two\n");
    await expectPolicyRefused(() => run.git.lifecycle("workspace").run({ cwd: project, args: ["add", "tracked.txt"] }));
    assert.equal(existsSync(sentinel), false);
  });
});

test("Task 9 refuses an included repository filter before the include can select a helper", async () => {
  await withProductionGit("include", async ({ root, project, run }) => {
    const sentinel = join(root, "include-sentinel.txt");
    await writeFile(join(root, "included.gitconfig"), "[filter \"evil\"]\n\tclean = sh -c 'cat; printf include > ../include-sentinel.txt'\n");
    await setConfig(project, "include.path", "../../included.gitconfig");
    await writeFile(join(project, ".gitattributes"), "tracked.txt filter=evil\n");
    await writeFile(join(project, "tracked.txt"), "two\n");
    await expectPolicyRefused(() => run.git.lifecycle("workspace").run({ cwd: project, args: ["add", "tracked.txt"] }));
    assert.equal(existsSync(sentinel), false);
  });
});

test("Task 9 refuses repository textconv before diff can launch it", async () => {
  await withProductionGit("textconv", async ({ root, project, run }) => {
    const sentinel = join(root, "textconv-sentinel.txt");
    await setConfig(project, "diff.evil.textconv", "sh -c 'printf textconv > ../textconv-sentinel.txt; cat \"$0\"'");
    await writeFile(join(project, ".gitattributes"), "tracked.txt diff=evil\n");
    await writeFile(join(project, "tracked.txt"), "two\n");
    await expectPolicyRefused(() => run.git.lifecycle("inspection").run({ cwd: project, args: ["diff", "--", "tracked.txt"] }));
    assert.equal(existsSync(sentinel), false);
  });
});

test("Task 9 refuses repository aliases before an alias shell can launch", async () => {
  await withProductionGit("alias", async ({ root, project, run }) => {
    const sentinel = join(root, "alias-sentinel.txt");
    await setConfig(project, "alias.evil", "!sh -c 'printf alias > ../alias-sentinel.txt'");
    await withCallGit(run, project, "alias", {}, async (git) => {
      await expectPolicyRefused(() => git.run({ cwd: project, args: ["evil"] }));
    });
    assert.equal(existsSync(sentinel), false);
  });
});

test("Task 9 refuses repository SSH command overrides before transport launch", async () => {
  await withProductionGit("ssh", async ({ root, project, run }) => {
    const sentinel = join(root, "ssh-sentinel.txt");
    await setConfig(project, "core.sshCommand", "sh -c 'printf ssh > ../ssh-sentinel.txt; exit 1' --");
    await fixtureGit({ cwd: project, args: ["remote", "add", "origin", "ssh://127.0.0.1/never"] });
    await withCallGit(run, project, "ssh", { network: true, external: true }, async (git) => {
      await expectPolicyRefused(() => git.run({ cwd: project,
        args: ["push", "origin", "HEAD:refs/heads/result"], allowFailure: true }));
    });
    assert.equal(existsSync(sentinel), false);
  });
});

test("Task 9 refuses repository remote-helper transports before helper launch", async () => {
  await withProductionGit("remote-helper", async ({ root, project, run }) => {
    const sentinel = join(root, "remote-helper-sentinel.txt");
    const helper = join(project, "evil-remote.sh");
    await writeFile(helper, "#!/bin/sh\nprintf remote > ../remote-helper-sentinel.txt\nexit 1\n");
    await chmod(helper, 0o755);
    await fixtureGit({ cwd: project, args: ["remote", "add", "origin", "ext::./evil-remote.sh"] });
    await withCallGit(run, project, "remote-helper", { network: true, external: true }, async (git) => {
      await expectPolicyRefused(() => git.run({ cwd: project,
        args: ["push", "origin", "HEAD:refs/heads/result"], allowFailure: true }));
    });
    assert.equal(existsSync(sentinel), false);
  });
});

test("Task 9 refuses custom submodule update commands before any update helper can be selected", async () => {
  await withProductionGit("submodule-update", async ({ root, project, run }) => {
    const sentinel = join(root, "submodule-sentinel.txt");
    await setConfig(project, "submodule.evil.update", "!sh -c 'printf submodule > ../submodule-sentinel.txt'");
    await withCallGit(run, project, "submodule-update", { network: true, external: true }, async (git) => {
      await expectPolicyRefused(() => git.run({ cwd: project, args: ["submodule", "update", "--init"] }));
    });
    assert.equal(existsSync(sentinel), false);
  });
});

test("Task 9 refuses editor-requiring commit shapes before Git can consult an editor", async () => {
  await withProductionGit("editor", async ({ root, project, run }) => {
    const sentinel = join(root, "editor-sentinel.txt");
    await setConfig(project, "core.editor", "sh -c 'printf editor > ../editor-sentinel.txt'");
    await writeFile(join(project, "tracked.txt"), "two\n");
    await fixtureGit({ cwd: project, args: ["add", "tracked.txt"] });
    await expectPolicyRefused(() => run.git.lifecycle("workspace").run({ cwd: project, args: ["commit"], env: identity }));
    assert.equal(existsSync(sentinel), false);
  });
});

test("Task 9 refuses interactive sequence-editor command modes before Git can consult a sequence editor", async () => {
  await withProductionGit("sequence-editor", async ({ root, project, run }) => {
    const sentinel = join(root, "sequence-editor-sentinel.txt");
    await setConfig(project, "sequence.editor", "sh -c 'printf sequence > ../sequence-editor-sentinel.txt'");
    await withCallGit(run, project, "sequence-editor", {}, async (git) => {
      await expectPolicyRefused(() => git.run({ cwd: project, args: ["rebase", "-i", "--root"], allowFailure: true }));
    });
    assert.equal(existsSync(sentinel), false);
  });
});

test("Task 9 refuses forced pager argv before repository pager configuration can run", async () => {
  await withProductionGit("pager", async ({ root, project, run }) => {
    const sentinel = join(root, "pager-sentinel.txt");
    await setConfig(project, "core.pager", "sh -c 'printf pager > ../pager-sentinel.txt; cat'");
    await withCallGit(run, project, "pager", {}, async (git) => {
      await expectPolicyRefused(() => git.run({ cwd: project, args: ["--paginate", "status"] }));
    });
    assert.equal(existsSync(sentinel), false);
  });
});

test("Task 9 neutralizes repository fsmonitor helpers", async () => {
  await withProductionGit("fsmonitor", async ({ root, project, run }) => {
    const sentinel = join(root, "fsmonitor-sentinel.txt");
    await setConfig(project, "core.fsmonitor", "sh -c 'printf fsmonitor > ../fsmonitor-sentinel.txt; exit 1'");
    await writeFile(join(project, "tracked.txt"), "two\n");
    await run.git.lifecycle("inspection").run({ cwd: project, args: ["status", "--porcelain=v1"], allowFailure: true });
    assert.equal(existsSync(sentinel), false);
  });
});

test("Task 9 refuses repository external diff before diff can launch it", async () => {
  await withProductionGit("external-diff", async ({ root, project, run }) => {
    const sentinel = join(root, "external-diff-sentinel.txt");
    await setConfig(project, "diff.external", "sh -c 'printf diff > ../external-diff-sentinel.txt; exit 1'");
    await writeFile(join(project, "tracked.txt"), "two\n");
    await expectPolicyRefused(() => run.git.lifecycle("inspection").run({ cwd: project, args: ["diff", "--", "tracked.txt"] }));
    assert.equal(existsSync(sentinel), false);
  });
});

test("Task 9 refuses repository credential helpers before an explicitly network-authorized push", async () => {
  await withProductionGit("credential-helper", async ({ root, project, run }) => {
    const sentinel = join(root, "credential-sentinel.txt");
    await setConfig(project, "credential.helper", "!sh -c 'printf credential > ../credential-sentinel.txt; echo username=evil; echo password=evil'");
    const server = createServer((_request, response) => {
      response.writeHead(401, { "WWW-Authenticate": "Basic realm=task9" });
      response.end("auth required");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      await fixtureGit({ cwd: project, args: ["remote", "add", "origin", `http://127.0.0.1:${address.port}/repo.git`] });
      await withCallGit(run, project, "credential-helper", { network: true, external: true }, async (git) => {
        await expectPolicyRefused(() => git.run({ cwd: project,
          args: ["push", "origin", "HEAD:refs/heads/result"], allowFailure: true }));
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    assert.equal(existsSync(sentinel), false);
  });
});