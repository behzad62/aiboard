import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import type { RunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import {
  createRunnerCapabilityContract,
  runnerCapabilitiesForContract,
  validateRunnerCapabilityContract,
} from "../src/runner-capability-contract.js";
import {
  languageServerCommandCandidates,
  resolveLanguageServerExecutable,
} from "../src/language-server-executable.js";

test("language-server command search preserves POSIX PATH and Windows cwd semantics", () => {
  const root = join("C:", "runner capability candidate fixture");
  assert.deepEqual(
    languageServerCommandCandidates("fixture-server", {
      commandSearchDirectory: root,
      environment: { PATH: "first:second::" },
      platform: "linux",
    }),
    [
      join(root, "first", "fixture-server"),
      join(root, "second", "fixture-server"),
      join(root, "fixture-server"),
    ],
    "POSIX bare commands use PATH only, with empty entries representing cwd",
  );
  assert.deepEqual(
    languageServerCommandCandidates("fixture-server", {
      commandSearchDirectory: root,
      environment: { PATH: "" },
      platform: "linux",
    }),
    [join(root, "fixture-server")],
    "an explicitly empty POSIX PATH contains one cwd entry",
  );
  assert.deepEqual(
    languageServerCommandCandidates("fixture-server", {
      commandSearchDirectory: root,
      environment: { PATH: "first;second;;", PATHEXT: ".CMD" },
      platform: "win32",
    }),
    [
      join(root, "fixture-server.cmd"),
      join(root, "first", "fixture-server.cmd"),
      join(root, "second", "fixture-server.cmd"),
    ],
    "Windows keeps cwd-first command lookup and applies only supported PATHEXT launchers",
  );
});

test("language-server executable resolution follows a PATH symlink to its canonical launcher", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-capability-executable-symlink-"));
  const bin = join(root, "bin");
  const command = process.platform === "win32" ? "fixture-lsp.cmd" : "fixture-lsp";
  const target = join(root, process.platform === "win32" ? "target.cmd" : "target-lsp");
  const intermediate = join(root, process.platform === "win32" ? "intermediate.cmd" : "intermediate-lsp");
  const alias = join(bin, command);
  try {
    mkdirSync(bin);
    writeLauncher(target, "canonical target");
    try {
      symlinkSync(target, intermediate, process.platform === "win32" ? "file" : undefined);
      symlinkSync(intermediate, alias, process.platform === "win32" ? "file" : undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("The host does not permit test symlink creation.");
        return;
      }
      throw error;
    }

    const identity = await resolveLanguageServerExecutable(command, {
      commandSearchDirectory: root,
      environment: { ...process.env, PATH: bin },
    });
    assert.equal(identity.path, realpathSync(target));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("language-server executable resolution skips shadowed unusable PATH candidates", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-capability-executable-shadow-"));
  const first = join(root, "first-bin");
  const second = join(root, "second-bin");
  const command = process.platform === "win32" ? "fixture-lsp.cmd" : "fixture-lsp";
  const shadow = join(first, command);
  const fallback = join(second, command);
  try {
    mkdirSync(first);
    mkdirSync(second);
    if (process.platform === "win32") {
      mkdirSync(shadow);
    } else {
      writeLauncher(shadow, "non-executable shadow");
      chmodSync(shadow, 0o644);
    }
    writeLauncher(fallback, "usable fallback");
    const environment = { ...process.env, PATH: `${first}${delimiter}${second}` };

    const identity = await resolveLanguageServerExecutable(command, {
      commandSearchDirectory: root,
      environment,
    });
    assert.equal(identity.path, realpathSync(fallback));

    await assert.rejects(
      resolveLanguageServerExecutable(command, {
        commandSearchDirectory: root,
        environment: { ...process.env, PATH: first },
      }),
      /was not found as a regular supported executable/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capability contracts attest the resolved launcher and reject a PATH replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-capability-executable-"));
  const first = join(root, "first-bin");
  const second = join(root, "second-bin");
  mkdirSync(first);
  mkdirSync(second);
  const command = process.platform === "win32" ? "fixture-lsp.cmd" : "fixture-lsp";
  const firstLauncher = join(first, command);
  const secondLauncher = join(second, command);
  try {
    writeLauncher(firstLauncher, "first");
    writeLauncher(secondLauncher, "second");
    const config: RunnerCapabilitiesConfig = {
      extensions: [],
      languageServers: [{
        descriptor: {
          id: "fixture.attested",
          displayName: "Attested fixture",
          extensions: [".fixture"],
          rootMarkers: [],
          priority: 1,
        },
        languageId: "fixture",
        command,
        args: [],
      }],
    };
    const firstEnvironment = {
      ...process.env,
      PATH: `${first}${delimiter}${process.env.PATH ?? ""}`,
    };
    const contract = await createRunnerCapabilityContract(config, {
      commandSearchDirectory: root,
      environment: firstEnvironment,
    });
    assert.equal(contract.languageServerExecutableIdentityVersion, 1);
    assert.equal(contract.languageServers[0]?.executable?.path, firstLauncher);
    const bound = runnerCapabilitiesForContract(config, contract);
    assert.equal(bound.languageServers[0]?.command, firstLauncher);
    assert.equal(
      bound.languageServers[0]?.commandIdentity?.digest,
      contract.languageServers[0]?.executable?.digest,
      "runtime configuration is pinned to the persisted canonical launcher rather than a fresh PATH lookup",
    );
    await validateRunnerCapabilityContract(contract, config, {
      commandSearchDirectory: root,
      environment: firstEnvironment,
    });

    await assert.rejects(
      validateRunnerCapabilityContract(contract, config, {
        commandSearchDirectory: root,
        environment: {
          ...process.env,
          PATH: `${second}${delimiter}${process.env.PATH ?? ""}`,
        },
      }),
      (error: unknown) =>
        (error as { code?: unknown }).code === "capability_contract_mismatch",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeLauncher(path: string, marker: string): void {
  if (process.platform === "win32") {
    writeFileSync(path, `@echo off\r\nrem ${marker}\r\nexit /b 0\r\n`);
    return;
  }
  writeFileSync(path, `#!/bin/sh\n# ${marker}\nexit 0\n`);
  chmodSync(path, 0o755);
}
