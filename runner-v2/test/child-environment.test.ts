import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

import {
  LOCAL_MCP_DEPTH_LIMIT,
  composeRunnerProcessEnvironments,
  createChildEnvironmentFactory,
  isWindowsAppsPathEntry,
  withoutRunnerInstallPath,
  type RunnerOwnedChildEnvironmentCredentialResolver,
} from "../src/child-environment.js";
import { pwshExecutable, shellInventory } from "../src/shell-inventory.js";
import { CliWorkerOwners } from "../src/cli-worker-runtime.js";

const NOW = "2026-08-28T12:00:00.000Z";
const GENERIC_GRANT_ERROR = /Child environment credential grant (?:is invalid|could not be consumed)\./;

interface GrantRecord {
  grantId: string;
  runId: string;
  invocationId: string;
  expiresAt?: string;
  names: string[];
  values: Record<string, string>;
}

function resolver(records: Record<string, GrantRecord>): RunnerOwnedChildEnvironmentCredentialResolver {
  const consumed = new Set<string>();
  return {
    consume(grantId) {
      if (consumed.has(grantId)) throw new Error(`SENTINEL_REPLAY_${grantId}`);
      consumed.add(grantId);
      const record = records[grantId];
      if (!record) throw new Error(`SENTINEL_UNKNOWN_${grantId}`);
      return record;
    },
  };
}

function factory(records: Record<string, GrantRecord> = {}) {
  return createChildEnvironmentFactory({
    credentialResolver: resolver(records),
    now: () => new Date(NOW),
  });
}

test("prepares a public name-only capability while preserving safe platform variables", () => {
  const prepared = factory().prepare({
    ambient: {
      Path: "C:\\Windows\\System32", TMP: "C:\\Temp", HOME: "C:\\Users\\runner",
      API_KEY: "SENTINEL_AMBIENT_KEY", Access_Token: "SENTINEL_AUTH_TOKEN",
      Authorization: "Bearer SENTINEL_HEADER", RUNNER_STATE_DIR: "C:\\private-state",
      RUNNER_AUTH_TOKEN: "SENTINEL_RUNNER_AUTH", SAFE_FLAG: "inherited",
    },
    explicitOverrides: { SAFE_FLAG: "overridden", api_key: "SENTINEL_HOSTILE_OVERRIDE", Runner_Control_Port: "9999" },
  });

  assert.deepEqual(prepared.audit.inheritedNames, ["HOME", "Path", "SAFE_FLAG", "TMP"]);
  assert.deepEqual(prepared.audit.removedNames, ["Access_Token", "API_KEY", "Authorization", "RUNNER_AUTH_TOKEN", "RUNNER_STATE_DIR"]);
  assert.deepEqual(prepared.audit.explicitSafeNames, ["SAFE_FLAG"]);
  assert.deepEqual(prepared.audit.grantedNames, []);
  assert.deepEqual(Object.keys(prepared).sort(), ["audit", "capability"]);
  assert.doesNotMatch(JSON.stringify(prepared), /SENTINEL_(?:AMBIENT_KEY|AUTH_TOKEN|HEADER|RUNNER_AUTH|HOSTILE_OVERRIDE)/);
});

test("explicit undefined removes an inherited safe variable by canonical name", () => {
  const runner = factory();
  const prepared = runner.prepare({
    ambient: { PATH: "/bin", GIT_DIR: "/hostile/git-dir", SAFE_FLAG: "visible" },
    explicitOverrides: { git_dir: undefined },
  });
  runner.withChildEnvironment(prepared.capability, (environment) => {
    assert.equal(environment.GIT_DIR, undefined);
    assert.equal(environment.git_dir, undefined);
    assert.equal(environment.SAFE_FLAG, "visible");
  });
  assert.ok(prepared.audit.removedNames.some((name) => name.toLowerCase() === "git_dir"));
});

test("removes provider-prefixed credentials from ambient and explicit input but admits an exact grant", () => {
  const sentinel = "SYNTHETIC_PROVIDER_ENV_SENTINEL";
  const runner = factory({
    grant_provider: {
      grantId: "grant_provider",
      runId: "run_provider",
      invocationId: "call_provider",
      names: ["OPENAI_API_KEY"],
      values: { OPENAI_API_KEY: "SYNTHETIC_GRANTED_PROVIDER_SENTINEL" },
    },
  });
  const prepared = runner.prepare({
    ambient: {
      PATH: "/bin",
      OPENAI_API_KEY: sentinel,
      ANTHROPIC_FOUNDRY_API_KEY: sentinel,
      AZURE_OPENAI_API_KEY: sentinel,
      SERVICE_PRIVATE_KEY: sentinel,
      OPENAI_API_VERSION: "2026-09-01",
    },
    explicitOverrides: { azureOpenaiApiKey: sentinel, SAFE_FLAG: "visible" },
    runId: "run_provider",
    invocationId: "call_provider",
    credentialGrantId: "grant_provider",
  });

  assert.deepEqual(prepared.audit.removedNames, [
    "ANTHROPIC_FOUNDRY_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "OPENAI_API_KEY",
    "SERVICE_PRIVATE_KEY",
  ]);
  assert.deepEqual(prepared.audit.explicitSafeNames, ["SAFE_FLAG"]);
  assert.deepEqual(prepared.audit.grantedNames, ["OPENAI_API_KEY"]);
  assert.doesNotMatch(JSON.stringify(prepared), new RegExp(sentinel));
  runner.withChildEnvironment(prepared.capability, (environment) => {
    assert.equal(environment.OPENAI_API_KEY, "SYNTHETIC_GRANTED_PROVIDER_SENTINEL");
    assert.equal(environment.OPENAI_API_VERSION, "2026-09-01");
    assert.equal(environment.SAFE_FLAG, "visible");
    assert.equal(environment.ANTHROPIC_FOUNDRY_API_KEY, undefined);
    assert.equal(environment.AZURE_OPENAI_API_KEY, undefined);
    assert.equal(environment.SERVICE_PRIVATE_KEY, undefined);
    assert.equal(environment.azureOpenaiApiKey, undefined);
  });
});

test("atomically consumes an authoritative opaque grant and exposes values only to the trusted callback once", () => {
  const runner = factory({ grant_1: { grantId: "grant_1", runId: "run_1", invocationId: "call_1", expiresAt: "2026-08-28T12:01:00.000Z", names: ["DEPLOY_TOKEN"], values: { DEPLOY_TOKEN: "SENTINEL_GRANTED_VALUE" } } });
  const prepared = runner.prepare({ ambient: { PATH: "/bin" }, runId: "run_1", invocationId: "call_1", credentialGrantId: "grant_1" });

  assert.deepEqual(prepared.audit.grantedNames, ["DEPLOY_TOKEN"]);
  assert.doesNotMatch(JSON.stringify(prepared), /SENTINEL_GRANTED_VALUE/);
  runner.withChildEnvironment(prepared.capability, (environment) => {
    assert.equal(environment.DEPLOY_TOKEN, "SENTINEL_GRANTED_VALUE");
    assert.equal(environment.PATH, "/bin");
  });
  assert.throws(() => runner.withChildEnvironment(prepared.capability, () => undefined), GENERIC_GRANT_ERROR);
});

test("rejects forged ids, replay, mismatched authoritative bindings, and expiry with generic errors", () => {
  const records = {
    grant_1: { grantId: "grant_1", runId: "run_1", invocationId: "call_1", names: ["DEPLOY_TOKEN"], values: { DEPLOY_TOKEN: "SENTINEL_VALUE" } },
    wrong_run: { grantId: "wrong_run", runId: "run_other", invocationId: "call_1", names: ["DEPLOY_TOKEN"], values: { DEPLOY_TOKEN: "SENTINEL_VALUE" } },
    wrong_call: { grantId: "wrong_call", runId: "run_1", invocationId: "call_other", names: ["DEPLOY_TOKEN"], values: { DEPLOY_TOKEN: "SENTINEL_VALUE" } },
    expired: { grantId: "expired", runId: "run_1", invocationId: "call_1", expiresAt: "2026-08-28T11:59:59.000Z", names: ["DEPLOY_TOKEN"], values: { DEPLOY_TOKEN: "SENTINEL_VALUE" } },
  };
  const runner = factory(records);
  const base = { ambient: { PATH: "/bin" }, runId: "run_1", invocationId: "call_1" };
  for (const credentialGrantId of ["forged", "wrong_run", "wrong_call", "expired"]) assert.throws(() => runner.prepare({ ...base, credentialGrantId }), GENERIC_GRANT_ERROR);
  runner.prepare({ ...base, credentialGrantId: "grant_1" });
  assert.throws(() => runner.prepare({ ...base, credentialGrantId: "grant_1" }), GENERIC_GRANT_ERROR);
  assert.throws(() => runner.withChildEnvironment({} as never, () => undefined), GENERIC_GRANT_ERROR);
});

test("factory atomically blocks non-consuming and reentrant grant redemption attempts", () => {
  const record: GrantRecord = {
    grantId: "grant_atomic", runId: "run_1", invocationId: "call_1",
    names: ["DEPLOY_TOKEN"], values: { DEPLOY_TOKEN: "SENTINEL_ATOMIC_VALUE" },
  };
  let attempts = 0;
  let reentrantError: unknown;
  const runner = createChildEnvironmentFactory({
    credentialResolver: {
      consume: () => {
        attempts += 1;
        if (attempts === 1) {
          try { runner.prepare({ ambient: { PATH: "/bin" }, runId: "run_1", invocationId: "call_1", credentialGrantId: "grant_atomic" }); }
          catch (error) { reentrantError = error; }
        }
        return record;
      },
    },
    now: () => new Date(NOW),
  });
  const input = { ambient: { PATH: "/bin" }, runId: "run_1", invocationId: "call_1", credentialGrantId: "grant_atomic" };
  runner.prepare(input);
  assert.match(reentrantError instanceof Error ? reentrantError.message : "", GENERIC_GRANT_ERROR);
  assert.equal(attempts, 1);
  assert.throws(() => runner.prepare(input), GENERIC_GRANT_ERROR);
  assert.equal(attempts, 1);
});

test("snapshots a getter-backed opaque grant id before reservation and redemption", () => {
  const record: GrantRecord = {
    grantId: "grant_real", runId: "run_1", invocationId: "call_1",
    names: ["DEPLOY_TOKEN"], values: { DEPLOY_TOKEN: "SENTINEL_SNAPSHOT_VALUE" },
  };
  let resolverAttempts = 0;
  const runner = createChildEnvironmentFactory({
    credentialResolver: {
      consume: (grantId) => {
        resolverAttempts += 1;
        if (grantId !== "grant_real") throw new Error("SENTINEL_UNEXPECTED_GRANT");
        return record;
      },
    },
    now: () => new Date(NOW),
  });
  let reads = 0;
  const getterBackedInput = {
    ambient: { PATH: "/bin" }, runId: "run_1", invocationId: "call_1",
    get credentialGrantId(): string {
      reads += 1;
      return reads === 2 ? "reservation_decoy" : "grant_real";
    },
  };

  runner.prepare(getterBackedInput);
  assert.equal(reads, 1);
  assert.equal(resolverAttempts, 1);
  assert.throws(() => runner.prepare({
    ambient: { PATH: "/bin" }, runId: "run_1", invocationId: "call_1", credentialGrantId: "grant_real",
  }), GENERIC_GRANT_ERROR);
  assert.equal(resolverAttempts, 1);
});

test("rejects non-credential, Runner, and canonical-colliding authoritative grant names", () => {
  for (const [id, names, values] of [
    ["path", ["PATH"], { PATH: "/other" }], ["runner", ["Runner_Control_Port"], { Runner_Control_Port: "1" }],
    ["duplicate", ["DEPLOY_TOKEN", "deploy_token"], { DEPLOY_TOKEN: "SENTINEL_VALUE" }],
    ["collision", ["DEPLOY_TOKEN"], { DEPLOY_TOKEN: "SENTINEL_VALUE", deploy_token: "SENTINEL_OTHER" }],
  ] as const) {
    const runner = factory({ [id]: { grantId: id, runId: "run_1", invocationId: "call_1", names: [...names], values: { ...values } } });
    assert.throws(() => runner.prepare({ ambient: { PATH: "/bin" }, runId: "run_1", invocationId: "call_1", credentialGrantId: id }), GENERIC_GRANT_ERROR);
  }
});

test("contains resolver and untrusted failures without reflecting sentinel names or values", () => {
  const runner = createChildEnvironmentFactory({ credentialResolver: { consume: () => { throw new Error("SENTINEL_PRIVATE_VALUE_AND_NAME"); } }, now: () => new Date(NOW) });
  let error: unknown;
  try { runner.prepare({ ambient: { PATH: "/bin" }, runId: "run_1", invocationId: "call_1", credentialGrantId: "SENTINEL_FORGED_ID" }); } catch (caught) { error = caught; }
  assert.match(error instanceof Error ? error.message : "", GENERIC_GRANT_ERROR);
  assert.doesNotMatch(error instanceof Error ? error.message : "", /SENTINEL/);
});

test("preserves reserved object-property environment names without adding environment hooks", () => {
  const runner = factory();
  const prepared = runner.prepare({ ambient: { PATH: "/bin", toJSON: "safe-to-json", constructor: "safe-constructor", prototype: "safe-prototype" } });
  runner.withChildEnvironment(prepared.capability, (environment) => {
    assert.equal(Object.getPrototypeOf(environment), null);
    assert.equal(environment.toJSON, "safe-to-json");
    assert.equal(environment.constructor, "safe-constructor");
    assert.equal(environment.prototype, "safe-prototype");
  });
});

test("strips Node test-runner coordination variables from ambient and explicit input", () => {
  const runner = factory();
  const prepared = runner.prepare({
    ambient: {
      PATH: "/bin",
      NODE_TEST_CONTEXT: "child-v8",
      NODE_TEST_WORKER_ID: "3",
      NODE_OPTIONS: "--max-old-space-size=512",
      SAFE_FLAG: "visible",
      API_KEY: "SENTINEL_AMBIENT_KEY",
    },
    explicitOverrides: { node_test_context: "child-v8", NODE_OPTIONS: "--max-old-space-size=1024" },
  });

  assert.ok(prepared.audit.removedNames.includes("NODE_TEST_CONTEXT"));
  assert.ok(prepared.audit.removedNames.includes("NODE_TEST_WORKER_ID"));
  assert.ok(prepared.audit.removedNames.includes("API_KEY"));
  assert.deepEqual(
    prepared.audit.decisions.filter((decision) => decision.kind === "removed_ambient").map((decision) => decision.name).sort(),
    ["API_KEY", "NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID"],
  );
  assert.ok(prepared.audit.decisions.some((decision) => decision.kind === "rejected_explicit" && decision.name === "node_test_context"));
  assert.deepEqual(prepared.audit.explicitSafeNames, ["NODE_OPTIONS"]);
  runner.withChildEnvironment(prepared.capability, (environment) => {
    assert.equal(environment.NODE_TEST_CONTEXT, undefined);
    assert.equal(environment.node_test_context, undefined);
    assert.equal(environment.NODE_TEST_WORKER_ID, undefined);
    assert.equal(environment.NODE_OPTIONS, "--max-old-space-size=1024");
    assert.equal(environment.SAFE_FLAG, "visible");
    assert.equal(environment.API_KEY, undefined);
  });
  assert.doesNotMatch(JSON.stringify(prepared), /SENTINEL_AMBIENT_KEY/);
});

// R3 (docs/runner-v2/codex-windows-job-escape-2026-11-18.md §4.2): a packaged program a descendant starts has its children
// created outside the Job, so the WindowsApps folders never reach a managed child's PATH on Windows.
test("R3: the WindowsApps alias and package folders are recognised, and nothing else", () => {
  for (const entry of [
    "C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps",
    "C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\",
    "c:/users/dev/appdata/local/microsoft/windowsapps/Microsoft.PowerShell_8wekyb3d8bbwe",
    "\"C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe\"",
    "D:\\WindowsApps\\PythonSoftwareFoundation.PythonManager_1.0.0.0_x64__qbz5n2kfra8p0",
    "C:\\PROGRA~1\\WindowsApps",
  ]) assert.equal(isWindowsAppsPathEntry(entry), entry.includes("PROGRA~1") ? false : true, entry);
  for (const entry of [
    "C:\\Program Files\\PowerShell\\7", "C:\\Windows\\System32", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    "C:\\tools\\WindowsAppsHelper", "C:\\x\\Microsoft\\WindowsApps2", "C:\\Program Files\\Git\\cmd", "",
    // Anchored: a folder that is merely named WindowsApps is not one Windows uses for packaged programs.
    "D:\\WindowsApps\\mytools", "D:\\projects\\Microsoft\\WindowsApps\\bin", "C:\\tools\\WindowsApps",
  ]) assert.equal(isWindowsAppsPathEntry(entry), false, entry);
});

test("R3: a Windows child's PATH loses the WindowsApps folders, after explicit overrides too; other platforms keep PATH", () => {
  // Forward-slash entries joined by the host's delimiter, so the case runs the same on every CI host.
  const alias = "/Users/dev/AppData/Local/Microsoft/WindowsApps";
  const perPackage = `${alias}/Microsoft.PowerShell_8wekyb3d8bbwe`;
  const tools = "/tools/bin";
  const prepare = (platform: NodeJS.Platform, explicitPath?: string) => {
    const environments = createChildEnvironmentFactory({ credentialResolver: resolver({}), now: () => new Date(NOW), platform });
    const prepared = environments.prepare({
      ambient: { PATH: [perPackage, tools, alias].join(delimiter) },
      ...(explicitPath === undefined ? {} : { explicitOverrides: { PATH: explicitPath } }),
    });
    return { audit: prepared.audit, ...environments.withChildEnvironment(prepared.capability, (environment, root) =>
      ({ path: environment.PATH, rootPath: root?.PATH, sameRoot: root === environment })) };
  };
  const windows = prepare("win32");
  assert.equal(windows.path, tools);
  assert.ok(windows.audit.decisions.some((entry) => entry.kind === "removed_packaged_alias_path" && entry.count === 2));
  // The launch's own program is looked up on the PATH that keeps them, in their places; the child never gets it.
  assert.equal(windows.rootPath, [perPackage, tools, alias].join(delimiter));
  assert.equal(prepare("win32", [alias, tools].join(delimiter)).path, tools, "an explicit PATH is filtered the same way");
  const linux = prepare("linux");
  assert.equal(linux.path, [perPackage, tools, alias].join(delimiter));
  assert.equal(linux.sameRoot, true, "with nothing removed the root program is looked up in the child's own environment");
  assert.equal(withoutRunnerInstallPath([alias, tools].join(delimiter), { platform: "win32" }), tools, "the child's PATH");
  assert.equal(withoutRunnerInstallPath([alias, tools].join(delimiter), { platform: "win32", purpose: "root_program" }), [alias, tools].join(delimiter),
    "a check's tool lookup searches where the launch looks for its own program");
  assert.equal(withoutRunnerInstallPath([alias, tools].join(delimiter), { platform: "darwin" }), [alias, tools].join(delimiter));
});

const HOST_WINDOWS_APPS = process.platform === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps") : undefined;
test("R3: a PATH entry that only reaches WindowsApps through its real path is removed too", {
  skip: (process.platform !== "win32" && "real-path spellings are a Windows case") ||
    ((!HOST_WINDOWS_APPS || !existsSync(HOST_WINDOWS_APPS)) && "needs %LOCALAPPDATA%\\Microsoft\\WindowsApps on this host"),
}, () => {
  const windowsApps = HOST_WINDOWS_APPS!;
  const root = mkdtempSync(join(tmpdir(), "aiboard-r3-"));
  try {
    const link = join(root, "apps");
    symlinkSync(windowsApps, link, "junction");
    assert.equal(realpathSync.native(link).toLowerCase(), realpathSync.native(windowsApps).toLowerCase());
    assert.equal(withoutRunnerInstallPath([link, root].join(delimiter), { platform: "win32" }), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R3: on a real Windows host the Runner's own shells are still found after the filter", { skip: process.platform !== "win32" && "the Runner's shell detection is Windows-specific here" }, async () => {
  // The filter runs on this host's own PATH: the child's PATH holds no WindowsApps folder, while detection reads the
  // Runner's own PATH, never a child's, so a Store-only pwsh is still listed and started as the Job's root
  // (shell-session.ts sessionLaunch, command-line.ts shellInvocation), and the launch's own lookup PATH still holds it.
  const environments = createChildEnvironmentFactory({ credentialResolver: resolver({}), now: () => new Date(NOW), platform: "win32" });
  const hostPath = Object.entries(process.env).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
  const prepared = environments.prepare({ ambient: { Path: hostPath } });
  const pathOf = (environment: Readonly<Record<string, string>>) => Object.entries(environment).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
  const { child, root } = environments.withChildEnvironment(prepared.capability, (environment, rootProgram) =>
    ({ child: pathOf(environment).split(delimiter), root: pathOf(rootProgram ?? environment).split(delimiter) }));
  assert.equal(child.filter(isWindowsAppsPathEntry).length, 0, "the child's PATH holds no WindowsApps folder");
  const shells = await shellInventory();
  assert.ok(shells.includes("cmd"));
  assert.ok(shells.some((shell) => shell.startsWith("powershell ")), JSON.stringify(shells));
  const pwsh = pwshExecutable();
  if (pwsh) assert.ok(shells.some((shell) => shell.startsWith("pwsh ")), JSON.stringify(shells));
  if (pwsh && isWindowsAppsPathEntry(dirname(pwsh))) {
    const folder = dirname(pwsh).toLowerCase();
    assert.ok(root.some((entry) => entry.toLowerCase().replace(/\\+$/u, "") === folder), "the launch's own lookup PATH keeps the Store pwsh's folder");
    assert.ok(!child.some((entry) => entry.toLowerCase().replace(/\\+$/u, "") === folder));
  }
});

test("CW5: a CLI worker's owner gets AIBOARD_MCP_DEPTH at the local limit; other owners keep the Runner's next depth", () => {
  const owners = new CliWorkerOwners();
  const playwright = (owner: { runId: string; sessionId: string }) => owner.sessionId === "cli" || owner.sessionId === "api"
    ? { values: { PLAYWRIGHT_CLI_SESSION: `t-${owner.sessionId}` }, pathPrepend: ["/pw/bin"] } : undefined;
  const environment = createChildEnvironmentFactory({
    credentialResolver: { consume() { throw new Error("none"); } }, mcpChildDepth: 1,
    processEnvironment: composeRunnerProcessEnvironments(playwright, owners.environmentFor),
  });
  const read = (sessionId: string, explicit: Record<string, string> = {}) => {
    const prepared = environment.prepare({ ambient: { PATH: "/usr/bin", AIBOARD_MCP_DEPTH: "0" }, explicitOverrides: explicit, runId: "r", sessionId });
    return environment.withChildEnvironment(prepared.capability, (values) => ({ ...values }));
  };
  assert.equal(read("cli").AIBOARD_MCP_DEPTH, "1", "an unregistered owner gets the Runner's next depth");
  owners.register({ runId: "r", sessionId: "cli" });
  const cli = read("cli", { AIBOARD_MCP_DEPTH: "0" });
  assert.equal(cli.AIBOARD_MCP_DEPTH, String(LOCAL_MCP_DEPTH_LIMIT), "Runner authority wins over a caller's value");
  assert.equal(cli.PLAYWRIGHT_CLI_SESSION, "t-cli", "the Playwright CLI values stay beside the depth");
  assert.equal(cli.AIBOARD_CLI_WORKER, "1", "CW8: the guard's marker for a CLI worker's processes");
  assert.equal(read("api").AIBOARD_CLI_WORKER, undefined);
  assert.equal((cli.PATH ?? cli.Path)!.split(process.platform === "win32" ? ";" : ":")[0], "/pw/bin");
  assert.equal(read("api").AIBOARD_MCP_DEPTH, "1");
  owners.release({ runId: "r", sessionId: "cli" });
  assert.equal(read("cli").AIBOARD_MCP_DEPTH, "1");
});

test("CW5: composed owner environments refuse a conflicting value and an invalid depth, and a depth never lowers the Runner's", () => {
  assert.equal(composeRunnerProcessEnvironments(undefined, undefined), undefined);
  const one = () => ({ values: { A: "1" }, pathPrepend: [] });
  assert.equal(composeRunnerProcessEnvironments(undefined, one), one);
  const conflict = composeRunnerProcessEnvironments(one, () => ({ values: { A: "2" }, pathPrepend: [] }))!;
  assert.throws(() => conflict({ runId: "r", sessionId: "s" }), /Runner process environment is invalid/);
  // Windows names are case-insensitive: a second spelling of one name is refused even with the same value.
  const spelling = composeRunnerProcessEnvironments(one, () => ({ values: { a: "1" }, pathPrepend: [] }))!;
  assert.throws(() => spelling({ runId: "r", sessionId: "s" }), /Runner process environment is invalid/);
  const merged = composeRunnerProcessEnvironments(one, () => ({ values: { A: "1", B: "2" }, pathPrepend: ["/x"], mcpDepth: 2 }), () => ({ values: {}, pathPrepend: ["/y"], mcpDepth: 1 }))!;
  assert.deepEqual(merged({ runId: "r", sessionId: "s" }), { values: { A: "1", B: "2" }, pathPrepend: ["/x", "/y"], mcpDepth: 2 });

  for (const mcpDepth of [0, -1, 1.5, Number.NaN, 2_000_000]) {
    const environment = createChildEnvironmentFactory({ credentialResolver: { consume() { throw new Error("none"); } }, mcpChildDepth: 1,
      processEnvironment: () => ({ values: {}, pathPrepend: [], mcpDepth }) });
    assert.throws(() => environment.prepare({ ambient: {}, runId: "r", sessionId: "s" }), /Runner process environment is invalid/, String(mcpDepth));
  }
  const nested = createChildEnvironmentFactory({ credentialResolver: { consume() { throw new Error("none"); } }, mcpChildDepth: 4,
    processEnvironment: () => ({ values: {}, pathPrepend: [], mcpDepth: 2 }) });
  const prepared = nested.prepare({ ambient: {}, runId: "r", sessionId: "s" });
  assert.equal(nested.withChildEnvironment(prepared.capability, (values) => values.AIBOARD_MCP_DEPTH), "4");
});
