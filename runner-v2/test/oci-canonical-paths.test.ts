import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import type { ExecutionIsolationLease } from "../src/execution-isolation-provider.js";
import {
  createOciExecutionIsolationProvider,
  OciExecutionIsolationError,
  type OciCli,
  type OciCliInvocation,
} from "../src/oci-execution-isolation-provider.js";
import { isTrustedRunnerHostAliasResolution } from "../src/runner-capabilities-config.js";

// Real filesystem/public provider coverage. The injected CLI never launches Docker.
test("OCI canonical paths acquire and release canonical grants on every host", async () => {
  const fixture = await pathFixture();
  try {
    const lease = await fixture.provider.acquire(fixture.request) as ExecutionIsolationLease;
    assert.deepEqual(lease.grantedAccess, fixture.claims.access);
    assert.equal(fixture.workloadCreates().length, 1);
    await fixture.provider.release(lease);
    assert.deepEqual(await fixture.provider.recoverOwned(), { cleaned: 0, blockers: [], transitions: [] });
  } finally { await fixture.close(); }
});

for (const field of ["cwd", "argv"] as const) {
  test(`OCI canonical host alias: Darwin ${field} preserves the exact granted target`, {
    skip: process.platform !== "darwin" && "Requires the actual Darwin /var host alias",
  }, async () => {
    const fixture = await pathFixture();
    try {
      const alias = fixture.root.replace(/^\/private\/var(?=\/)/, "/var");
      assert.notEqual(alias, fixture.root, "fixture must live below the real /var host alias");
      assert.equal(await realpath("/var"), "/private/var");
      assert.equal(isTrustedRunnerHostAliasResolution(alias, fixture.root), true);
      const intent = {
        ...fixture.intent,
        ...(field === "cwd" ? { workingDirectory: join(alias, "workspace") } : {
          arguments: [join(alias, "workspace", "build.mjs"), join(alias, "external", "input.txt")],
        }),
      };
      const lease = await fixture.provider.acquire({ ...fixture.request, intent }) as ExecutionIsolationLease;
      try {
        assert.deepEqual(lease.grantedAccess, fixture.claims.access);
        const create = fixture.workloadCreates()[0]!;
        assert.ok(create);
        assert.deepEqual(values(create.args, "--workdir"), ["/runner/workspace"]);
        assert.deepEqual(values(create.args, "--mount"), [
          `type=bind,src=${fixture.workspace},dst=/runner/workspace`,
          `type=bind,src=${fixture.external},dst=/runner/grants/0,readonly`,
        ]);
        assert.deepEqual(create.args.slice(-3), ["node", "/runner/workspace/build.mjs", "/runner/grants/0/input.txt"]);
      } finally {
        await fixture.provider.release(lease);
      }
      assert.deepEqual(await fixture.provider.recoverOwned(), { cleaned: 0, blockers: [], transitions: [] });
    } finally { await fixture.close(); }
  });
}

test("OCI canonical host alias cannot replace an issued canonical grant root", {
  skip: process.platform !== "darwin" && "Requires the actual Darwin /var host alias",
}, async () => {
  const fixture = await pathFixture();
  try {
    const alias = fixture.workspace.replace(/^\/private\/var(?=\/)/, "/var");
    assert.notEqual(alias, fixture.workspace);
    const grant = { ...fixture.claims, access: fixture.claims.access.map((entry, index) =>
      index === 0 ? { ...entry, canonicalPath: alias } : entry) };
    await assert.rejects(fixture.provider.acquire({ ...fixture.request, grant }), pathEscape);
    assert.equal(fixture.workloadCreates().length, 0);
  } finally { await fixture.close(); }
});

for (const field of ["cwd", "argv", "grant"] as const) {
  test(`OCI canonical paths reject a user parent alias inside the same grant: ${field}`, async () => {
    const fixture = await pathFixture();
    try {
      const alias = join(fixture.root, "var-lookalike");
      await symlink(fixture.workspace, alias, process.platform === "win32" ? "junction" : "dir");
      const intent = {
        ...fixture.intent,
        ...(field === "cwd" ? { workingDirectory: alias } : {}),
        ...(field === "argv" ? { arguments: [join(alias, "build.mjs")] } : {}),
      };
      const grant = field === "grant" ? {
        ...fixture.claims,
        access: fixture.claims.access.map((entry, index) => index === 0 ? { ...entry, canonicalPath: alias } : entry),
      } : fixture.claims;
      await assert.rejects(fixture.provider.acquire({ ...fixture.request, intent, grant }), pathEscape);
      assert.equal(fixture.workloadCreates().length, 0);
    } finally { await fixture.close(); }
  });
}

for (const broken of [false, true]) {
  test(`OCI canonical paths reject ${broken ? "broken" : "nested"} links below a host-native spelling`, async () => {
    const fixture = await pathFixture();
    try {
      const link = join(fixture.workspace, "linked");
      await symlink(broken ? join(fixture.root, "missing") : fixture.external, link,
        process.platform === "win32" ? "junction" : "dir");
      const requested = process.platform === "darwin" ? link.replace(/^\/private\/var(?=\/)/, "/var") : link;
      await assert.rejects(fixture.provider.acquire({ ...fixture.request,
        intent: { ...fixture.intent, arguments: [join(requested, "input.txt")] },
      }), pathEscape);
      assert.equal(fixture.workloadCreates().length, 0);
    } finally { await fixture.close(); }
  });
}

function pathEscape(error: unknown): boolean {
  return error instanceof OciExecutionIsolationError && error.code === "oci_path_escape";
}

async function pathFixture() {
  const temporary = await mkdtemp(join(tmpdir(), "runner-oci-path-"));
  const root = await realpath(temporary);
  try {
    const workspace = join(root, "workspace");
    const external = join(root, "external");
    const state = join(root, "state");
    const cliPath = join(root, "fixture-cli");
    await Promise.all([mkdir(workspace), mkdir(external), mkdir(state), writeFile(cliPath, "inert attested fixture")]);
    await Promise.all([writeFile(join(workspace, "build.mjs"), ""), writeFile(join(external, "input.txt"), "input")]);
    const binding = {
      runId: "run", sessionId: "session", actor: { role: "worker" as const, id: "worker" },
      toolName: "process.run", callId: "call", permissionProfile: "project" as const,
    };
    const authority = createExecutionGrantAuthority();
    const grant = await authority.issue({ ...binding, workspacePath: workspace,
      access: [{ path: workspace, mode: "write" }, { path: external, mode: "read" }],
      externalApproved: true, destructiveApproved: false, networkApproved: false,
    });
    const claims = authority.consume(grant, binding);
    const intent = {
      invocationId: "invocation", runId: "run", sessionId: "session", kind: "command" as const,
      executable: "node", arguments: [join(workspace, "build.mjs"), join(external, "input.txt")],
      workingDirectory: workspace, requiredLifecycleScope: "contained_workload" as const,
      requestedCapabilities: ["write_confinement" as const],
    };
    const calls: OciCliInvocation[] = [];
    const provider = createOciExecutionIsolationProvider({
      providerId: "oci-path", cliPath, image: "fixture/image", stateDirectory: state, cli: pathCli(calls),
    });
    await provider.attest();
    return { root, workspace, external, claims, intent, provider,
      request: { providerId: "oci-path", implementationDigest: "a".repeat(64), intent, grant: claims },
      workloadCreates: () => calls.filter((call) => call.args[0] === "create" &&
        !values(call.args, "--label").includes("ai-board.runner-v2.probe=true")),
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

function values(args: readonly string[], option: string): string[] {
  return args.flatMap((value, index) => value === option ? [args[index + 1]!] : []);
}

function pathCli(calls: OciCliInvocation[]): OciCli {
  const image = `sha256:${"1".repeat(64)}`;
  const containers = new Map<string, { name: string; labels: Record<string, string> }>();
  const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
  const absent = () => ({ exitCode: 1, stdout: "", stderr: "not found" });
  return {
    async run(invocation) {
      calls.push(structuredClone(invocation));
      const args = invocation.args;
      switch (args[0]) {
        case "image": return ok(image);
        case "run": return ok(`${args.at(-1)}\n`);
        case "ps": return ok([...containers].filter(([, value]) => args
          .filter((arg) => arg.startsWith("label=")).every((arg) => {
            const label = arg.slice(6); const separator = label.indexOf("=");
            return value.labels[label.slice(0, separator)] === label.slice(separator + 1);
          })).map(([id]) => id).join("\n"));
        case "create": {
          const id = `fixture-${calls.length}`;
          containers.set(id, { name: values(args, "--name")[0]!, labels: Object.fromEntries(values(args, "--label").map((label) => {
            const index = label.indexOf("="); return [label.slice(0, index), label.slice(index + 1)];
          })) });
          return ok(id);
        }
        case "rm": containers.delete(args.at(-1)!); return ok();
        case "inspect": {
          const id = args.at(-1)!;
          const entry = containers.get(id);
          if (!entry) return absent();
          const format = values(args, "--format")[0];
          if (format === "{{.Id}}") return ok(id);
          if (format === "{{.Image}}") return ok(image);
          if (format === "{{.Name}}") return ok(`/${entry.name}`);
          assert.equal(format, "{{json .Config.Labels}}");
          return ok(JSON.stringify(entry.labels));
        }
        default: assert.fail(`Unexpected path-fixture CLI command: ${args.join(" ")}`);
      }
    },
    async runDuplex(invocation, input) {
      calls.push(structuredClone(invocation));
      assert.deepEqual(invocation.args.slice(0, 3), ["start", "--attach", "--interactive"]);
      assert.equal(containers.has(invocation.args.at(-1)!), true);
      return ok(input.trimEnd());
    },
  };
}
