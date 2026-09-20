import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as configuration from "../src/mcp-configuration.js";
const { configureMcpServers, fixedMcpEnvelope, mcpConfigurationDigest, snapshotMcpServerSpec } = configuration;
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { lifecycleRequirementsDigest } from "../src/execution-lifecycle-policy.js";
import { createRunnerInternalExecutionContext } from "../src/runner-internal-execution-context.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { McpServerSpec } from "../src/mcp-tools.js";
import type { RunnerInternalProcessKernel } from "../src/runner-internal-process-kernel.js";

async function fixture(t: TestContext, body: (context: ReturnType<typeof createRunnerInternalExecutionContext>, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "p682-config-"));
  t.diagnostic(`exact non-native MCP configuration fixture acquired: ${root}`);
  let launches = 0; let passed = false;
  const kernel = { launch: async () => { launches++; assert.fail("static attestation must never spawn"); }, close: async () => undefined,
    activeCount: () => 0 } as unknown as RunnerInternalProcessKernel;
  const context = createRunnerInternalExecutionContext({ projectDirectory: root, stateDirectory: join(root, "state"),
    processKernel: kernel, ambientEnvironment: {} });
  try { await body(context, root); assert.equal(launches, 0); passed = true; }
  finally { await context.close(); if (passed) { await rm(root, { recursive: true }); t.diagnostic(`static fixture closed and removed: ${root}`); }
    else t.diagnostic(`static failed fixture retained: ${root}`); }
}
const command = `"${process.execPath}"`;
const capabilitiesConfig = emptyRunnerCapabilitiesConfig();

for (const [label, suffix] of [
  ["shell conjunction", " --version && echo forbidden"],
  ["shell pipe", " --version | echo forbidden"],
  ["shell redirect", " --version > output"],
  ["shell sequence", " --version; echo forbidden"],
  ["unterminated quotation", ' "unterminated'],
  ["command substitution", " $(echo forbidden)"],
  ["backtick substitution", " `echo forbidden`"],
  ["newline", "\n--version"],
  ["ambiguous quote concatenation", ' "part"tail'],
] as const) test(`MCP static configuration refuses ${label} instead of inventing shell execution`, async (t) => fixture(t, async (context) => {
  await assert.rejects(context.attestConfiguredCapabilities({ mcpServers: [{ name: "docs", command: command + suffix }], capabilitiesConfig }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "mcp_command_invalid");
}));

test("MCP missing executable is a typed attestation refusal, never a shell-wrapper identity", async (t) => fixture(t, async (context) => {
  await assert.rejects(context.attestConfiguredCapabilities({ mcpServers: [{ name: "docs", command: "definitely-missing-mcp-command-682" }], capabilitiesConfig }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "mcp_executable_unavailable");
}));

test("MCP exact quoted command retains literal arguments without shell expansion", async (t) => fixture(t, async (context) => {
  const servers = [{ name: "docs", command: command + ` 'literal path' "literal;not-shell" ""` }];
  const attested = await context.attestConfiguredCapabilities({ mcpServers: servers, capabilitiesConfig });
  const launches = await context.resolveMcpRuntimeLaunches({ servers, attestation: attested.mcp });
  assert.equal(launches[0]!.executablePath, process.execPath);
  assert.deepEqual(launches[0]!.arguments, ["literal path", "literal;not-shell", ""]);
}));

test("MCP config digest binds the fixed envelope rather than only name and command", async (t) => fixture(t, async (context) => {
  const base = { name: "docs", command };
  const attest = async (server: McpServerSpec) => (await context.attestConfiguredCapabilities({ mcpServers: [server], capabilitiesConfig })).mcp[0]!;
  const legacy = await attest(base);
  const paths = await attest({ ...base, envelope: { paths: [{ path: ".", mode: "read" }] } } as McpServerSpec);
  const network = await attest({ ...base, envelope: { network: true } } as McpServerSpec);
  const credential = await attest({ ...base, envelope: { credentialNames: ["DECLARED_TOKEN"] } } as McpServerSpec);
  assert.equal(new Set([legacy, paths, network, credential].map((entry) => entry.configDigest)).size, 4);
}));

test("MCP config digest binds trusted lifecycle requirements into exact configuration identity", () => {
  const base = { name: "docs", command };
  const legacy = mcpConfigurationDigest(base);
  const cleanup = mcpConfigurationDigest({ ...base, lifecycleRequirements: { requireCompleteCleanup: true } });
  const detachment = mcpConfigurationDigest({ ...base, lifecycleRequirements: { knownUnavoidableDetachment: true } });
  const both = mcpConfigurationDigest({
    ...base,
    lifecycleRequirements: { requireCompleteCleanup: true, knownUnavoidableDetachment: true },
  });
  assert.equal(new Set([legacy, cleanup, detachment, both]).size, 4);
  assert.equal(
    mcpConfigurationDigest({ ...base, lifecycleRequirements: { requireCompleteCleanup: false } }),
    legacy,
  );
});

test("MCP snapshot canonicalizes true lifecycle flags and omits false-only requirements", () => {
  const snapshotted = snapshotMcpServerSpec({
    name: "docs",
    command,
    lifecycleRequirements: {
      requireCompleteCleanup: true,
      knownUnavoidableDetachment: false,
    },
  });
  assert.deepEqual(snapshotted.lifecycleRequirements, { requireCompleteCleanup: true });
  assert.equal(Object.isFrozen(snapshotted.lifecycleRequirements), true);
  assert.equal(Object.hasOwn(snapshotMcpServerSpec({
    name: "docs",
    command,
    lifecycleRequirements: { requireCompleteCleanup: false, knownUnavoidableDetachment: false },
  }), "lifecycleRequirements"), false);
  assert.equal(Object.hasOwn(snapshotMcpServerSpec({ name: "docs", command }), "lifecycleRequirements"), false);
});

for (const lifecycleRequirements of [
  { unknown: true },
  { requireCompleteCleanup: "yes" },
  { requireCompleteCleanup: true, extra: false },
  [],
  null,
  "complete",
] as const) {
  test(`MCP snapshot rejects malformed lifecycleRequirements ${JSON.stringify(lifecycleRequirements)}`, () => {
    assert.throws(
      () => snapshotMcpServerSpec({ name: "docs", command, lifecycleRequirements } as McpServerSpec),
      (error: unknown) => error instanceof Error &&
        ((error as { code?: string }).code === "mcp_command_invalid" || /lifecycle|invalid|configuration/i.test(error.message)),
    );
  });
}

test("MCP resolve preserves frozen lifecycle requirements and digest on the runtime launch descriptor", async (t) => fixture(t, async (context) => {
  const lifecycleRequirements = { requireCompleteCleanup: true as const };
  const servers = [{ name: "docs", command, lifecycleRequirements }];
  const attested = await context.attestConfiguredCapabilities({ mcpServers: servers, capabilitiesConfig });
  const launches = await context.resolveMcpRuntimeLaunches({ servers, attestation: attested.mcp });
  assert.deepEqual(launches[0]!.lifecycleRequirements, { requireCompleteCleanup: true });
  assert.equal(launches[0]!.lifecycleRequirementsDigest, lifecycleRequirementsDigest(lifecycleRequirements));
  assert.equal(launches[0]!.configDigest, mcpConfigurationDigest(servers[0]!));
  assert.equal(Object.hasOwn((await context.resolveMcpRuntimeLaunches({
    servers: [{ name: "docs", command }],
    attestation: (await context.attestConfiguredCapabilities({
      mcpServers: [{ name: "docs", command }],
      capabilitiesConfig,
    })).mcp,
  }))[0]!, "lifecycleRequirements"), false);
}));

test("MCP config replacement cannot reuse the trusted old attestation even when argv is unchanged", async (t) => fixture(t, async (context) => {
  const servers = [{ name: "docs", command, envelope: { paths: [{ path: ".", mode: "read" }] } }] as McpServerSpec[];
  const attested = await context.attestConfiguredCapabilities({ mcpServers: servers, capabilitiesConfig });
  const replaced = [{ name: "docs", command, envelope: { network: true } }] as McpServerSpec[];
  await assert.rejects(context.resolveMcpRuntimeLaunches({ servers: replaced, attestation: attested.mcp }), /attestation|configuration|identity/i);
}));

for (const envelope of [
  { paths: [{ path: "../escape", mode: "write" }] },
  { paths: [{ path: ".", mode: "all" }] },
  { paths: [{ path: ".", mode: "read" }, { path: ".", mode: "write" }] },
  { network: "yes" },
  { credentialNames: ["DECLARED_TOKEN", "DECLARED_TOKEN"] },
  { credentialNames: ["invalid name"] },
  { unknown: true },
]) test(`MCP conservative envelope rejects ${JSON.stringify(envelope)}`, async (t) => fixture(t, async (context) => {
  await assert.rejects(context.attestConfiguredCapabilities({ mcpServers: [{ name: "docs", command, envelope } as McpServerSpec], capabilitiesConfig }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "mcp_envelope_invalid");
}));

test("MCP re-attests the exact executable before supplying a live launch descriptor", async (t) => fixture(t, async (context, root) => {
  const executable = join(root, process.platform === "win32" ? "fixture.exe" : "fixture");
  await writeFile(executable, "unexecuted identity-v1"); await chmod(executable, 0o700);
  const servers = [{ name: "docs", command: `"${executable}"` }];
  const attested = await context.attestConfiguredCapabilities({ mcpServers: servers, capabilitiesConfig });
  await writeFile(executable, "unexecuted identity-v2");
  await assert.rejects(context.resolveMcpRuntimeLaunches({ servers, attestation: attested.mcp }), /identity changed/i);
}));


test("MCP CLI envelope declarations are order independent, exact-name scoped and never mutate legacy specs", () => {
  const servers = [{ name: "docs", command }, { name: "other", command }];
  const result = configureMcpServers(servers, ['docs={"paths":[{"path":".","mode":"read"}],"network":true}']);
  assert.deepEqual(result[0]!.envelope, { paths: [{ path: ".", mode: "read" }], network: true, credentialNames: [] });
  assert.deepEqual(result[1]!.envelope, { paths: [], network: false, credentialNames: [] });
  assert.equal(Object.hasOwn(servers[0]!, "envelope"), false);
  assert.equal(Object.isFrozen(result), true);
});

for (const values of [['unknown={}'], ['docs={}', 'docs={}'], ['docs=[]'], ['docs=null'], ['docs=broken-json'], ['docs={"command":"replacement"}'], ['docs={"network":"yes"}']])
  test(`MCP CLI refuses ambiguous envelope declarations ${JSON.stringify(values)}`, () => {
    assert.throws(() => configureMcpServers([{ name: "docs", command }], values), /MCP|envelope|configuration/i);
  });

for (const property of ["paths", "credentialNames"] as const) test(`MCP configuration does not invoke ${property} array getters`, () => {
  let invoked = 0;
  const values: unknown[] = [];
  Object.defineProperty(values, "0", { get: () => { invoked++; return property === "paths" ? { path: ".", mode: "read" } : "TOKEN"; }, enumerable: true });
  assert.throws(() => fixedMcpEnvelope({ [property]: values } as never), /envelope/i);
  assert.equal(invoked, 0);
});

test("MCP server catalog and fixed paths stay bounded and dense", () => {
  assert.throws(() => configureMcpServers(Array.from({ length: 129 }, (_, index) => ({ name: `server${index}`, command })), []), /bound/i);
  assert.throws(() => configureMcpServers([{ name: "docs", command }, { name: "docs", command }], []), /duplicate/i);
  const sparse = new Array(2); sparse[1] = { path: ".", mode: "read" };
  assert.throws(() => fixedMcpEnvelope({ paths: sparse }), /envelope/i);
});


test("MCP executable re-attestation uses bounded descriptor reads rather than starvable whole-file readFile", async (t) => fixture(t, async (context) => {
  const original = filesystem.readFile;
  let wholeExecutableReads = 0;
  t.mock.method(filesystem, "readFile", async (path: unknown, ...args: unknown[]) => {
    if (String(path).toLowerCase() === process.execPath.toLowerCase()) { wholeExecutableReads++; throw new Error("whole-file executable read deliberately unavailable"); }
    return Reflect.apply(original, filesystem, [path, ...args]);
  });
  syncBuiltinESMExports();
  try {
    const servers = [{ name: "docs", command }];
    const attested = await context.attestConfiguredCapabilities({ mcpServers: servers, capabilitiesConfig });
    assert.match(attested.mcp[0]!.executableDigest, /^[a-f0-9]{64}$/);
    const current = await context.resolveMcpRuntimeLaunches({ servers, attestation: attested.mcp });
    assert.equal(current[0]!.executableDigest, attested.mcp[0]!.executableDigest);
    assert.equal(wholeExecutableReads, 0, "the live portable host polls between async completions, so the executable must not require hundreds of implicit small readFile turns");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}));


test("MCP re-attestation verifies the pinned executable without repeating ambient PATH resolution", async (t) => fixture(t, async (_unused, root) => {
  const kernel = { launch: async () => assert.fail("static identity checks cannot spawn"), activeCount: () => 0, close: async () => undefined } as unknown as RunnerInternalProcessKernel;
  const context = createRunnerInternalExecutionContext({ projectDirectory: root, stateDirectory: join(root, "pinned-state"), processKernel: kernel,
    ambientEnvironment: { PATH: [root, dirname(process.execPath)].join(delimiter), PATHEXT: ".COM;.EXE;.BAT;.CMD" } });
  const servers = [{ name: "docs", command: basename(process.execPath).replace(/\.exe$/i, "") }];
  try {
    const attested = await context.attestConfiguredCapabilities({ mcpServers: servers, capabilitiesConfig });
    const first = await context.resolveMcpRuntimeLaunches({ servers, attestation: attested.mcp });
    const pinned = first[0]!.executablePath;
    let otherCandidates = 0;
    const original = filesystem.realpath;
    t.mock.method(filesystem, "realpath", async (path: unknown, ...args: unknown[]) => {
      if (String(path).toLowerCase() !== pinned.toLowerCase()) otherCandidates++;
      return Reflect.apply(original, filesystem, [path, ...args]);
    });
    syncBuiltinESMExports();
    const repeated = await context.resolveMcpRuntimeLaunches({ servers, attestation: attested.mcp });
    assert.equal(repeated[0]!.executableDigest, first[0]!.executableDigest);
    assert.equal(otherCandidates, 0, "live launch is pinned to its original absolute executable, not a newly searched PATH candidate");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await context.close(); }
}));
