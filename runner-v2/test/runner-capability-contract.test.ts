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
import { createHash } from "node:crypto";

import type { RunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import {
  assertRunnerCapabilityContract,
  captureRunnerExtensionClosure,
  cloneRunnerCapabilityContract,
  createRunnerCapabilityContract,
  createRunnerCapabilityContractSnapshot,
  runnerCapabilitiesForContract,
  validateRunnerCapabilityContract,
} from "../src/runner-capability-contract.js";
import { EXECUTION_SAFETY_CONTRACT_VERSION } from "../src/execution-safety-contracts.js";

test("capability extension and snapshot state roots reject user-created aliases", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "runner-capability-root-alias-"));
  const extension = join(root, "extension");
  const extensionAlias = join(root, "extension-alias");
  const state = join(root, "state");
  const stateAlias = join(root, "state-alias");
  const cliDirectory = join(root, "cli");
  const cliAlias = join(root, "cli-alias");
  const cli = join(cliDirectory, process.platform === "win32" ? "oci.exe" : "oci");
  try {
    mkdirSync(extension);
    mkdirSync(state);
    mkdirSync(cliDirectory);
    writeFileSync(cli, "fixture executable bytes");
    writeFileSync(join(extension, "runner-extension.json"), JSON.stringify({
      apiVersion: 1,
      id: "fixture.alias-root",
      name: "fixture.alias-root",
      version: "1.0.0",
      entry: "index.mjs",
      capabilities: ["tools"],
    }));
    writeFileSync(join(extension, "index.mjs"), "export default {};\n");
    try {
      symlinkSync(extension, extensionAlias, process.platform === "win32" ? "junction" : "dir");
      symlinkSync(state, stateAlias, process.platform === "win32" ? "junction" : "dir");
      symlinkSync(cliDirectory, cliAlias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("The host does not permit directory alias creation.");
        return;
      }
      throw error;
    }
    await assert.rejects(captureRunnerExtensionClosure(extensionAlias), /symbolic link/i);
    await assert.rejects(
      createRunnerCapabilityContractSnapshot({ extensions: [extension], languageServers: [] }, stateAlias),
      /symbolic link/i,
    );
    await assert.rejects(
      createRunnerCapabilityContract({
        extensions: [],
        languageServers: [],
        isolationProviders: [{
          id: "oci.alias",
          type: "oci",
          cliPath: join(cliAlias, process.platform === "win32" ? "oci.exe" : "oci"),
          image: "fixture/image:latest",
          allowNetwork: false,
        }],
      }),
      /symbolic path/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS host-native tmp alias is accepted for extension and snapshot state roots", async (context) => {
  if (process.platform !== "darwin") {
    context.skip("macOS host-native path alias fixture requires Darwin.");
    return;
  }
  const root = mkdtempSync(join("/var/tmp", "runner-capability-darwin-host-alias-"));
  const extension = join(root, "extension");
  const state = join(root, "state");
  const cli = join(root, "oci");
  try {
    mkdirSync(extension);
    mkdirSync(state);
    writeFileSync(cli, "fixture executable bytes");
    writeFileSync(join(extension, "runner-extension.json"), JSON.stringify({
      apiVersion: 1,
      id: "fixture.darwin-host-alias",
      name: "fixture.darwin-host-alias",
      version: "1.0.0",
      entry: "index.mjs",
      capabilities: ["tools"],
    }));
    writeFileSync(join(extension, "index.mjs"), "export default {};\n");
    const canonicalExtension = realpathSync(extension);
    const canonicalState = realpathSync(state);
    assert.notEqual(extension, canonicalExtension, "fixture must enter through the macOS /var or /tmp host alias");
    assert.notEqual(state, canonicalState, "fixture state root must enter through the macOS host alias");
    const closure = await captureRunnerExtensionClosure(extension);
    assert.equal(closure.directory, canonicalExtension);
    const contract = await createRunnerCapabilityContractSnapshot({
      extensions: [extension],
      languageServers: [],
      isolationProviders: [{
        id: "oci.darwin-host-alias",
        type: "oci",
        cliPath: cli,
        image: "fixture/image:latest",
        allowNetwork: false,
      }],
    }, state);
    assert.equal(contract.extensions.length, 1);
    assert.equal(contract.isolationProviders?.[0]?.executable.path, realpathSync(cli));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("current capability snapshots bind the execution-safety contract version into the digest", async () => {
  const contract = await createRunnerCapabilityContract({ extensions: [], languageServers: [] });
  assert.equal(contract.executionSafetyVersion, EXECUTION_SAFETY_CONTRACT_VERSION);

  const withoutExecutionSafety = {
    version: contract.version,
    extensionClosureVersion: contract.extensionClosureVersion,
    languageServerExecutableIdentityVersion: contract.languageServerExecutableIdentityVersion,
    builtin: contract.builtin,
    extensions: contract.extensions,
    languageServers: contract.languageServers,
  };
  assert.notEqual(contract.digest, fixtureDigest(withoutExecutionSafety));
});

test("capability contracts bind optional OCI configuration without probing or discovering Docker", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-capability-oci-"));
  const cli = join(root, process.platform === "win32" ? "configured.exe" : "configured");
  writeFileSync(cli, "not executed by capability projection");
  try {
    const config: RunnerCapabilitiesConfig = {
      extensions: [],
      languageServers: [],
      isolationProviders: [{
        id: "oci.configured",
        type: "oci",
        cliPath: cli,
        image: "configured/image:only",
        allowNetwork: false,
      }],
    };
    const contract = await createRunnerCapabilityContract(config);
    assert.equal(contract.isolationProviders?.length, 1);
    assert.equal(contract.isolationProviders?.[0]?.id, "oci.configured");
    assert.match(contract.isolationProviders?.[0]?.configDigest ?? "", /^[a-f0-9]{64}$/);
    const changed = await createRunnerCapabilityContract({
      ...config,
      isolationProviders: [{ ...config.isolationProviders![0]!, allowNetwork: true }],
    });
    assert.notEqual(changed.digest, contract.digest);
    const boundProviders = runnerCapabilitiesForContract(config, contract).isolationProviders;
    assert.deepEqual(boundProviders?.map(({ cliIdentity: _identity, ...provider }) => provider),
      config.isolationProviders);
    assert.deepEqual(boundProviders?.[0]?.cliIdentity, contract.isolationProviders?.[0]?.executable);
    assert.notEqual(
      runnerCapabilitiesForContract(config, contract).isolationProviders,
      config.isolationProviders,
    );
    writeFileSync(cli, "replacement executable bytes");
    await assert.rejects(
      validateRunnerCapabilityContract(contract, config),
      (error: unknown) => (error as { code?: unknown }).code === "capability_contract_mismatch",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("historical capability contracts remain readable but cannot recover an active Build", async () => {
  const current = await createRunnerCapabilityContract({ extensions: [], languageServers: [] });
  const historicalPayload = {
    version: current.version,
    extensionClosureVersion: current.extensionClosureVersion,
    languageServerExecutableIdentityVersion: current.languageServerExecutableIdentityVersion,
    builtin: current.builtin,
    extensions: current.extensions,
    languageServers: current.languageServers,
  };
  const historical = { ...historicalPayload, digest: fixtureDigest(historicalPayload) };
  assert.doesNotThrow(() => assertRunnerCapabilityContract(historical));
  assert.equal(cloneRunnerCapabilityContract(historical).executionSafetyVersion, undefined);
  await assert.rejects(
    validateRunnerCapabilityContract(historical, { extensions: [], languageServers: [] }),
    (error: unknown) => (error as { code?: unknown }).code === "capability_contract_missing",
  );
});

test("unsupported execution-safety versions remain readable but are refused for active recovery", async () => {
  const current = await createRunnerCapabilityContract({ extensions: [], languageServers: [] });
  const unsupportedPayload = { ...current, executionSafetyVersion: 2, digest: undefined };
  const { digest: _digest, ...payload } = unsupportedPayload;
  const unsupported = { ...payload, digest: fixtureDigest(payload) };
  assert.doesNotThrow(() => assertRunnerCapabilityContract(unsupported));
  assert.equal(cloneRunnerCapabilityContract(unsupported).executionSafetyVersion, 2);
  await assert.rejects(
    validateRunnerCapabilityContract(unsupported, { extensions: [], languageServers: [] }),
    (error: unknown) => (error as { code?: unknown }).code === "capability_contract_mismatch",
  );
});
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

function fixtureDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  throw new Error("unsupported fixture value");
}
