import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const source = fileURLToPath(new URL("../src/", import.meta.url));
const mutationNames = new Set(["writeFile", "appendFile", "write", "writev", "rename", "unlink", "rm", "rmdir", "mkdir", "mkdtemp", "copyFile", "cp", "truncate", "ftruncate", "symlink", "link", "chmod", "fchmod", "chown", "fchown", "utimes", "futimes", "open"]);
// Closed audit list, NOT a sandbox. New native FS owners require review. These
// modules own Runner-private state/SQLite/artifacts/protocol files or existing
// run-owned verification/Git-worktree lifecycle, never native fs.* tool targets.
const privateOwners = new Set([
  "artifact-store.ts", "bounded-output-spool.ts", "browser-tools.ts", "cli.ts", "command-evidence-identity.ts", // private GIT_INDEX_FILE snapshots under attested run root outside cwd; separate index per capture, cleans only created tmp.
  "durable-process-store.ts",
  "encrypted-provider-config-store.ts", "execution-host.ts", "execution-isolation-provider.ts",
  "final-verification-cleanup.ts", "final-verification-port-authority.ts", "final-verification-profile.ts",
  "git-baseline.ts", "git-bootstrap.ts", "git-preflight.ts", "integration-manager.ts", "managed-process-record.ts",
  "managed-process-supervisor.mjs", "managed-process.ts", "native-build-factory.ts", "native-process-backend.ts",
  "oci-execution-isolation-provider.ts", "owned-fence-lock.mjs", "permission-store.ts", "plugin-loader.ts",
  "portable-process-channel.ts", "portable-process-child.mjs", "portable-process-protocol.mjs", "portable-process-supervisor.mjs",
  "release-archive.ts", // fresh release bundle extraction under the managed install's versions staging directory.
  "runner-capability-contract.ts", "runner-internal-execution-context.ts", "runner-internal-process-kernel.ts",
  "sqlite-agent-session-store.ts", "sqlite-budget-ledger.ts", "sqlite-build-spec-store.ts", "sqlite-context-manifest-store.ts", "sqlite-event-store.ts",
  "sqlite-evidence-store.ts", "sqlite-project-memory.ts", "sqlite-scheduler-store.ts", "sqlite-tool-ledger.ts",
  "streaming-session-store.ts", "verification-workspace.ts", "windows-job-process-host.ts", "windows-process-semantic-probes.ts", "workspace-manager.ts",
  // Reviewed 2026-10-31 (docs/runner-v2/filesystem-owner-review-2026-10-31.md). State and extension
  // home are refused at startup when they resolve into the project, lexically or through a link
  // (runner-start isInsideProject); remote-only nested state is deliberate and its owned roots are
  // protected from Remote tools. Ownership-hardening follow-ups are tracked in that review.
  "build-user-media.ts", // user-input media manifests/objects under state/user-input-media; expired-run cleanup there.
  "chat-agent-session.ts", // chat session records under state/chat-sessions.
  "credential-migration.ts", // credential journal, pointer and generations under state.
  "delivery-execution.ts", // removes only its own .aiboard-report-* residue in the run-owned verification workspace, canonically confined.
  "extension-management-service.ts", // upload staging under extension-home/uploads.
  "extension-mcp-launcher.ts", // MCP runtime launcher and per-server secret files under extension home.
  "extension-mcp.ts", // MCP runtimes, OAuth/policy JSON under extension home; discovery run under state/builds.
  "extension-package-store.ts", // digest-addressed packages, staging and GC under extension home.
  "extension-registry.ts", // extension registry, generations and lock under extension home.
  "extension-run-bindings.ts", // per-run extension bindings under state/extension-bindings.
  "extension-sources.ts", // random Git scratch directory under extension-home/scratch.
  "launcher-instance.ts", // launcher identity, instance and control-key files under launcher state.
  "launcher.ts", // peer records and peer control keys under launcher state.
  "proven-snapshot-links.ts", // appends proof records to the Build run root under state.
  "remote-admission-store.ts", // parent directory of state/remote-admission.sqlite.
  "remote-audit-store.ts", // parent directory of state/remote-audit.sqlite.
  "remote-device-store.ts", // Remote device identity, session, owner record and keys under device state.
  "remote-principal.ts", // parent directories of principal and device-policy databases under state/device state.
  "remote-service.ts", // state/remote-status.json.
  "runner-start.ts", // creates the configured state directory and state/artifacts after the overlap check.
  "self-update.ts", // managed install (versions, bin, staging, lock); on uninstall removes only its own marked profile block and fish file.
  "storage-key.ts", // state/storage-key via exclusive temp plus hard link.
  "toolbench-session.ts", // ToolBench session snapshots/manifests/transcripts under state/toolbench.
]);
// Read-handle-only owners: exact reviewed mutation-capable import per module.
// Async open owners keep ["open"]; the sync report reader keeps ["openSync"].
// test-report-readers.ts reads confined verification reports through one
// openSync(canonicalFile, "r") descriptor with canonical parent/leaf checks
// before open and descriptor-bound bounded revalidation after; the checkout
// root is already the read boundary, never a mutation target. No generic
// privateOwner entry: any other import or write/mkdir/rm/rename API fails.
const readHandleOwners = new Map<string, readonly string[]>([
  ["artifact-reachability.ts", ["open"]],
  ["mcp-executable-digest.ts", ["open"]],
  ["remote-artifact-transfer.ts", ["open"]], // opens the artifact source with "r" for streaming.
  ["remote-connector.ts", ["open"]], // opens the artifact index with "r" for reading.
  ["repository-intelligence.ts", ["open"]],
  ["test-report-readers.ts", ["openSync"]],
  ["windows-birth-inspection.mjs", ["openSync"]],
  ["windows-birth/session.mjs", ["openSync"]],
]);
function assertReadOnlyOpenSync(ast: ts.SourceFile, name: string): void {
  const openCalls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (mutationNames.has(callee.replace(/Sync$/, ""))) {
        assert.equal(callee, "openSync", `${name} must not invoke mutation API ${callee}`);
        openCalls.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(openCalls.length, 1, `${name} must invoke openSync exactly once`);
  const flag = openCalls[0]!.arguments[1];
  assert.ok(flag !== undefined && ts.isStringLiteral(flag) && flag.text === "r", `${name} must open with literal "r"`);
}
function sourceFiles(directory: string, prefix = ""): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return sourceFiles(join(directory, entry.name), name);
    return entry.isFile() && /\.(ts|mjs|js)$/.test(entry.name) ? [name] : [];
  });
}
test("native filesystem mutation-capable imports have a closed reviewed ownership boundary", () => {
  const found: string[] = [];
  for (const name of sourceFiles(source)) {
    const text = fs.readFileSync(join(source, name), "utf8");
    const ast = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    for (const node of ast.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || !/^node:fs(?:\/promises)?$/.test(node.moduleSpecifier.text)) continue;
      const clause = node.importClause; const bindings = clause?.namedBindings;
      const imports = clause?.name ? ["*"] : [];
      if (bindings) {
        if (ts.isNamespaceImport(bindings)) imports.push("*");
        else for (const item of bindings.elements) { const api = (item.propertyName ?? item.name).text;
          if (mutationNames.has(api.replace(/Sync$/, ""))) imports.push(api); }
      }
      if (imports.length === 0) continue;
      found.push(name);
      if (readHandleOwners.has(name)) {
        assert.deepEqual(imports, [...readHandleOwners.get(name)!], `${name} is inspected only for read handles`);
        if (name === "test-report-readers.ts" || name === "windows-birth-inspection.mjs" || name === "windows-birth/session.mjs") assertReadOnlyOpenSync(ast, name);
      }
      else assert.ok(name === "filesystem-mutation-fence.ts" || privateOwners.has(name), `Unreviewed native filesystem owner: ${name} (${imports})`);
    }
  }
  assert.ok(found.includes("filesystem-mutation-fence.ts"));
  assert.equal(found.includes("filesystem-tools.ts"), false, "Model-selected mutations may not regain raw fs APIs");
});

test("all four native mutations and bootstrap content route through the trusted seam", () => {
  const tools = fs.readFileSync(join(source, "filesystem-tools.ts"), "utf8");
  for (const operation of ["fencedWrite", "fencedPatch", "fencedMove", "fencedDelete"]) assert.match(tools, new RegExp(`${operation}\\(context,`));
  const baseline = fs.readFileSync(join(source, "git-baseline.ts"), "utf8");
  assert.match(baseline, /fencedWrite\(/); assert.doesNotMatch(baseline, /\b(?:appendFile|writeFile)\s*\(/);
});
