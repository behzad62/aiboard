import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";

import {
  capabilitiesConfigCanonicalTargetIsInsideProject,
  loadRunnerCapabilitiesConfig,
  resolveRunnerCapabilitiesConfigPath,
  RunnerCapabilitiesConfigError,
} from "../src/runner-capabilities-config.js";

test("capability configuration loads exact allowlisted extensions and bounded language servers", async () => {
  const fixture = configFixture("valid Ω");
  try {
    const extension = join(fixture.root, "extension Ω");
    mkdirSync(extension);
    fixture.write({
      version: 1,
      extensions: [extension],
      languageServers: [{
        id: "python.fixture",
        displayName: "Fixture Python",
        extensions: [".py"],
        rootMarkers: ["pyproject.toml"],
        priority: 50,
        languageId: "python",
        command: process.execPath,
        args: ["server.mjs", "--stdio"],
        requestTimeoutMs: 2_000,
        shutdownTimeoutMs: 500,
        restartLimit: 2,
        maxFrameBytes: 1_048_576,
        maxPendingRequests: 32,
        maxDocumentBytes: 262_144,
      }],
      isolationProviders: [{
        id: "docker.fixture",
        type: "oci",
        cliPath: process.execPath,
        image: "fixture/image@sha256:" + "a".repeat(64),
        allowNetwork: false,
      }],
    });

    const loaded = await loadRunnerCapabilitiesConfig(fixture.path);
    assert.deepEqual(loaded.extensions, [extension]);
    assert.deepEqual(loaded.languageServers, [{
      descriptor: {
        id: "python.fixture",
        displayName: "Fixture Python",
        extensions: [".py"],
        rootMarkers: ["pyproject.toml"],
        priority: 50,
      },
      languageId: "python",
      command: process.execPath,
      args: ["server.mjs", "--stdio"],
      requestTimeoutMs: 2_000,
      shutdownTimeoutMs: 500,
      restartLimit: 2,
      maxFrameBytes: 1_048_576,
      maxPendingRequests: 32,
      maxDocumentBytes: 262_144,
    }]);
    assert.deepEqual(loaded.isolationProviders, [{
      id: "docker.fixture",
      type: "oci",
      cliPath: process.execPath,
      image: "fixture/image@sha256:" + "a".repeat(64),
      allowNetwork: false,
    }]);
  } finally {
    fixture.close();
  }
});

test("capability configuration rejects unknown fields, duplicate identities, relative allowlists, and symlinks", async () => {
  const fixture = configFixture("hostile");
  try {
    for (const [input, code] of [
      [{ version: 1, extensions: [], languageServers: [], surprise: true }, "unknown_field"],
      [{
        version: 1,
        extensions: [],
        languageServers: [server("same"), server("same")],
      }, "duplicate_language_provider"],
      [{ version: 1, extensions: ["relative/plugin"], languageServers: [] }, "invalid_extension_path"],
      [{ version: 2, extensions: [], languageServers: [] }, "unsupported_version"],
      [{
        version: 1,
        extensions: [],
        languageServers: [],
        isolationProviders: [{
          id: "oci.relative",
          type: "oci",
          cliPath: "docker",
          image: "alpine:latest",
          allowNetwork: false,
        }],
      }, "invalid_isolation_provider"],
      [{
        version: 1,
        extensions: [],
        languageServers: [],
        isolationProviders: [{
          id: "oci.unknown",
          type: "oci",
          cliPath: process.execPath,
          image: "alpine:latest",
          allowNetwork: false,
          privileged: true,
        }],
      }, "unknown_field"],
      [{
        version: 1,
        extensions: [],
        languageServers: [{ ...server("unknown.server"), environment: { SECRET: "no" } }],
      }, "unknown_field"],
    ] as const) {
      fixture.write(input);
      await assert.rejects(
        loadRunnerCapabilitiesConfig(fixture.path),
        isConfigError(code),
      );
    }

    fixture.write({ version: 1, extensions: [], languageServers: [] });
    const alias = join(fixture.root, "config-link.json");
    symlinkSync(fixture.path, alias, "file");
    await assert.rejects(
      loadRunnerCapabilitiesConfig(alias),
      isConfigError("symbolic_config"),
    );
  } finally {
    fixture.close();
  }
});

test("capability configuration rejects a regular file reached through a user-created parent alias", async () => {
  const fixture = configFixture("prefix-alias");
  const aliasRoot = join(dirname(fixture.root), `${basename(fixture.root)}-alias`);
  try {
    fixture.write({ version: 1, extensions: [], languageServers: [] });
    symlinkSync(fixture.root, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const aliased = join(aliasRoot, basename(fixture.path));
    assert.notEqual(
      normalizePath(aliased),
      normalizePath(realpathSync(aliased)),
      "the fixture must exercise a non-canonical directory prefix",
    );
    await assert.rejects(
      loadRunnerCapabilitiesConfig(aliased),
      isConfigError("symbolic_config"),
    );
  } finally {
    rmSync(aliasRoot, { recursive: true, force: true });
    fixture.close();
  }
});

test("capability configuration loads a regular file when only host-native path aliases differ", async () => {
  const fixture = configFixture("host-alias");
  try {
    fixture.write({ version: 1, extensions: [], languageServers: [] });
    const canonical = realpathSync(fixture.path);
    if (normalizePath(fixture.path) === normalizePath(canonical)) return;
    const loaded = await loadRunnerCapabilitiesConfig(fixture.path);
    assert.deepEqual(loaded.extensions, []);
    assert.equal(normalizePath(await resolveRunnerCapabilitiesConfigPath(fixture.path)), normalizePath(canonical));
  } finally {
    fixture.close();
  }
});

test("capability configuration confinement uses the canonical target, not the lexical alias", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-capabilities-confine-"));
  const project = join(root, "project");
  const outside = join(root, "outside");
  mkdirSync(project);
  mkdirSync(outside);
  const insideConfig = join(project, "runner-capabilities.json");
  const outsideConfig = join(outside, "runner-capabilities.json");
  writeFileSync(insideConfig, JSON.stringify({ version: 1, extensions: [], languageServers: [] }));
  writeFileSync(outsideConfig, JSON.stringify({ version: 1, extensions: [], languageServers: [] }));
  const aliasRoot = join(outside, "alias");
  try {
    symlinkSync(project, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const lexical = join(aliasRoot, "runner-capabilities.json");
    assert.equal(isLexicallyInside(project, lexical), false, "the lexical alias must appear outside the project");
    assert.equal(isLexicallyInside(project, realpathSync(lexical)), true, "the canonical target must be inside the project");
    await assert.rejects(
      loadRunnerCapabilitiesConfig(lexical),
      isConfigError("symbolic_config"),
    );
    await assert.rejects(
      capabilitiesConfigCanonicalTargetIsInsideProject(project, lexical),
      isConfigError("symbolic_config"),
    );
    assert.equal(await capabilitiesConfigCanonicalTargetIsInsideProject(project, insideConfig), true);
    assert.equal(await capabilitiesConfigCanonicalTargetIsInsideProject(project, outsideConfig), false);

    const canonicalProject = realpathSync(project);
    if (normalizePath(project) !== normalizePath(canonicalProject)) {
      const hostAliasedInside = join(project, "runner-capabilities.json");
      assert.equal(
        await capabilitiesConfigCanonicalTargetIsInsideProject(canonicalProject, hostAliasedInside),
        true,
        "a trusted OS path alias that lands inside the project must still be confined",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function isLexicallyInside(parent: string, candidate: string): boolean {
  const traversal = relative(parent, candidate);
  return traversal === "" || (!traversal.startsWith("..") && !isAbsolute(traversal));
}

function normalizePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function server(id: string) {
  return {
    id,
    displayName: id,
    extensions: [".fixture"],
    rootMarkers: [],
    priority: 0,
    languageId: "fixture",
    command: process.execPath,
    args: [],
  };
}

function configFixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `aiboard-capabilities-${name}-`));
  const path = join(root, "runner capabilities.json");
  return {
    root,
    path,
    write(value: unknown) {
      writeFileSync(path, JSON.stringify(value));
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function isConfigError(code: string) {
  return (error: unknown) =>
    error instanceof RunnerCapabilitiesConfigError && error.code === code;
}
