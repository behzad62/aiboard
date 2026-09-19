import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..");
const SOURCE_ROOT = join(REPOSITORY_ROOT, "runner-v2", "src");
const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs", ".cjs", ".ps1"]);
const CHILD_PROCESS_MODULE = /^(?:node:)?child_process$/;
const LAUNCH_APIS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
type RawExecutionRule = Readonly<{
  file: string;
  container: string;
  kinds: readonly string[];
  reason: string;
}>;
const RAW_EXECUTION_ALLOWLIST: readonly RawExecutionRule[] = [
  { file: "managed-process-supervisor.mjs", container: "<module>", kinds: ["child-process-import"], reason: "authenticated Windows Job supervisor host import only" },
  { file: "managed-process-supervisor.mjs", container: "launchWindowsJob", kinds: ["powershell-script-launcher", "child-process-spawn", "powershell-launcher"], reason: "authenticated Job helper starts only the fixed Job host script" },
  { file: "managed-process-supervisor.mjs", container: "stopOwnedTree", kinds: ["member-kill"], reason: "authenticated Job helper terminates only its owned backend handle" },
  { file: "native-process-backend.ts", container: "<module>", kinds: ["child-process-import", "process-kill"], reason: "native backend imports and its fixed default existence probe" },
  { file: "native-process-backend.ts", container: "launch", kinds: ["child-process-spawn"], reason: "approved native backend workload launch seam" },
  { file: "native-process-backend.ts", container: "windowsPortableSupervisorHelpers", kinds: ["powershell-launcher", "taskkill-launcher"], reason: "native backend binds exact Windows helper paths from the injected SystemRoot before portable supervisor launch" },
  { file: "native-process-backend.ts", container: "osProcessBirthAsync", kinds: ["process-kill", "powershell-launcher", "child-process-execFile"], reason: "exact OS birth inspection only" },
  { file: "native-process-backend.ts", container: "osProcessBirth", kinds: ["process-kill", "child-process-execFileSync", "powershell-launcher"], reason: "exact OS birth inspection only" },
  { file: "native-process-backend.ts", container: "osProcessBirths", kinds: ["process-kill", "child-process-execFileSync", "powershell-launcher"], reason: "batched exact OS birth inspection only" },
  { file: "native-process-backend.ts", container: "osPosixGroupMembers", kinds: ["child-process-execFileSync"], reason: "POSIX membership inspection only" },
  { file: "native-process-backend.ts", container: "pidAlive", kinds: ["process-kill"], reason: "non-destructive exact PID existence probe only" },
  { file: "oci-execution-isolation-provider.ts", container: "<module>", kinds: ["child-process-import"], reason: "approved OCI provider host import only" },
  { file: "oci-execution-isolation-provider.ts", container: "append", kinds: ["member-kill"], reason: "bounded OCI CLI child timeout cleanup" },
  { file: "oci-execution-isolation-provider.ts", container: "execute", kinds: ["member-kill"], reason: "bounded OCI CLI child timeout cleanup" },
  { file: "owned-fence-lock.mjs", container: "<module>", kinds: ["child-process-import"], reason: "owned-fence identity helper import only" },
  { file: "owned-fence-lock.mjs", container: "inspectProcessBirth", kinds: ["child-process-execFileSync", "powershell-launcher"], reason: "fenced Windows birth inspection only" },
  { file: "owned-fence-lock.mjs", container: "probeExistence", kinds: ["process-kill"], reason: "non-destructive fenced PID existence probe only" },
  { file: "owned-fence-lock.mjs", container: "inspectBirth", kinds: ["child-process-execFileSync"], reason: "fenced POSIX birth inspection only" },
  { file: "portable-process-child.mjs", container: "<module>", kinds: ["child-process-import"], reason: "approved portable child host import only" },
  { file: "portable-process-child.mjs", container: "runPosixBootstrap", kinds: ["child-process-spawn"], reason: "approved portable child executable launch" },
  { file: "portable-process-child.mjs", container: "runWindowsBootstrap", kinds: ["child-process-spawn", "process-kill"], reason: "approved portable Windows child launch/signal propagation" },
  { file: "portable-process-child.mjs", container: "resolveWindowsArgvLaunch", kinds: ["powershell-launcher"], reason: "fixed batch argv shim identity only" },
  { file: "portable-process-posix-control.mjs", container: "<module>", kinds: ["child-process-import"], reason: "portable POSIX identity helper import only" },
  { file: "portable-process-posix-control.mjs", container: "inspectPosixProcessIdentity", kinds: ["child-process-execFileSync"], reason: "exact POSIX process identity inspection only" },
  { file: "portable-process-posix-control.mjs", container: "listOwnedPosixGroupMembers", kinds: ["child-process-execFileSync"], reason: "exact POSIX process-group membership inspection only" },
  { file: "portable-process-supervisor.mjs", container: "<module>", kinds: ["child-process-import", "child-process-spawn"], reason: "approved portable supervisor bootstrap/child launch seam" },
  { file: "portable-process-supervisor.mjs", container: "handleControl", kinds: ["taskkill-launcher", "child-process-spawnSync"], reason: "fenced Windows tree-control fallback only" },
  { file: "portable-process-supervisor.mjs", container: "requestWindowsTreeRefresh", kinds: ["powershell-launcher", "child-process-spawn", "member-kill"], reason: "bounded authenticated Windows tree inventory only" },
  { file: "portable-process-supervisor.mjs", container: "refreshWindowsTree", kinds: ["powershell-launcher", "child-process-spawnSync"], reason: "bounded authenticated Windows tree inventory only" },
  { file: "portable-process-supervisor.mjs", container: "activeOwnedPids", kinds: ["child-process-spawnSync"], reason: "owned Windows membership inspection only" },
  { file: "portable-process-supervisor.mjs", container: "inspectWindowsBirth", kinds: ["powershell-launcher", "child-process-spawnSync"], reason: "owned Windows birth inspection only" },
  { file: "portable-process-supervisor.mjs", container: "isAlive", kinds: ["process-kill"], reason: "non-destructive PID existence probe only" },
  { file: "windows-job-process-host.ts", container: "<module>", kinds: ["child-process-import"], reason: "authenticated Windows Job host import only" },
  { file: "windows-job-process-host.ts", container: "launchOwned", kinds: ["child-process-spawn"], reason: "authenticated Windows Job supervisor launch" },
  { file: "windows-job-process-host.ts", container: "probeActiveJobCreateClose", kinds: ["powershell-script-launcher", "powershell-launcher", "child-process-spawnSync"], reason: "fixed active Job create/close semantic probe" },
  { file: "windows-job-process-host.ts", container: "abortStartingSupervisor", kinds: ["member-kill"], reason: "pre-adoption owned supervisor rollback only" },
  { file: "windows-process-semantic-probes.ts", container: "<module>", kinds: ["child-process-import"], reason: "capability-probe inspection helper import only" },
  { file: "windows-process-semantic-probes.ts", container: "stopExactProbeSupervisor", kinds: ["child-process-execFileSync", "taskkill-launcher"], reason: "bounded exact semantic-probe fixture cleanup only" },
  { file: "windows-process-semantic-probes.ts", container: "probeProcessInventory", kinds: ["child-process-execFileSync", "powershell-launcher"], reason: "capability-probe process inventory only" },
  { file: "windows-process-semantic-probes.ts", container: "probeGlobalProcessInventory", kinds: ["child-process-execFileSync", "powershell-launcher"], reason: "capability-probe global inventory only" },
] as const;

type Finding = Readonly<{
  file: string;
  line: number;
  container: string;
  kind: string;
  detail: string;
}>;
function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase()) ? [path] : [];
  });
}

function location(file: string, source: ts.SourceFile, node: ts.Node, kind: string, detail: string): Finding {
  return Object.freeze({
    file: relative(SOURCE_ROOT, file).replaceAll("\\", "/"),
    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    container: containingSymbol(node),
    kind,
    detail,
  });
}

function containingSymbol(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText();
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) &&
        current.initializer && (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))) {
      return current.name.text;
    }
  }
  return "<module>";
}
function moduleCall(node: ts.Expression | undefined): boolean {
  if (!node || !ts.isCallExpression(node) || node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]!)) return false;
  const target = node.arguments[0]!.text;
  if (!CHILD_PROCESS_MODULE.test(target)) return false;
  return ts.isIdentifier(node.expression) && node.expression.text === "require" || node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function unwrapImport(node: ts.Expression | undefined): ts.Expression | undefined {
  return node && ts.isAwaitExpression(node) ? node.expression : node;
}

function bindingAliases(source: ts.SourceFile): Readonly<{
  aliases: ReadonlyMap<string, string>;
  namespaces: ReadonlySet<string>;
}> {
  const aliases = new Map<string, string>();
  const namespaces = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
        CHILD_PROCESS_MODULE.test(node.moduleSpecifier.text)) {
      const clause = node.importClause?.namedBindings;
      if (clause && ts.isNamespaceImport(clause)) namespaces.add(clause.name.text);
      if (clause && ts.isNamedImports(clause)) for (const element of clause.elements) {
        aliases.set(element.name.text, element.propertyName?.text ?? element.name.text);
      }
    }
    if (ts.isVariableDeclaration(node)) {
      const initializer = unwrapImport(node.initializer);
      if (moduleCall(initializer)) {
        if (ts.isIdentifier(node.name)) namespaces.add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)) for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name)) aliases.set(element.name.text, element.propertyName?.getText(source) ?? element.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { aliases, namespaces };
}
function auditSource(file: string): Finding[] {
  const text = readFileSync(file, "utf8");
  if (extname(file).toLowerCase() === ".ps1") return auditPowerShell(file, text);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const { aliases, namespaces } = bindingAliases(source);
  const rawProcessModule = /(?:node:)?child_process/.test(text);
  const findings: Finding[] = [];
  const add = (node: ts.Node, kind: string, detail: string) => findings.push(location(file, source, node, kind, detail));
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && CHILD_PROCESS_MODULE.test(node.moduleSpecifier.text)) {
      add(node, "child-process-import", node.importClause?.getText(source) ?? "side-effect import");
    }
    if (ts.isCallExpression(node) && moduleCall(node)) add(node, "dynamic-child-process-load", node.getText(source));
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === "process" && node.name.text === "env") add(node, "ambient-process-env", "process.env");
    if (ts.isCallExpression(node)) auditCall(node, source, aliases, namespaces, add);
    if (rawProcessModule && ts.isPropertyAssignment(node) &&
        node.name.getText(source).replace(/["']/g, "") === "shell" &&
        node.initializer.kind !== ts.SyntaxKind.FalseKeyword) add(node, "shell-flag", node.getText(source));
    if (rawProcessModule && ts.isStringLiteralLike(node)) {
      const value = node.text.trim();
      if (/(?:^|[\\/])taskkill(?:\.exe)?$/i.test(value)) add(node, "taskkill-launcher", value);
      if (/(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(value)) add(node, "powershell-launcher", value);
      if (/\.ps1$/i.test(value)) add(node, "powershell-script-launcher", value);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}
function auditCall(
  node: ts.CallExpression,
  source: ts.SourceFile,
  aliases: ReadonlyMap<string, string>,
  namespaces: ReadonlySet<string>,
  add: (node: ts.Node, kind: string, detail: string) => void,
): void {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    const api = aliases.get(callee.text);
    if (api && LAUNCH_APIS.has(api)) add(node, `child-process-${api}`, callee.text);
    return;
  }
  if (!ts.isPropertyAccessExpression(callee)) return;
  if (ts.isIdentifier(callee.expression) && callee.expression.text === "process" && callee.name.text === "kill") {
    add(node, "process-kill", callee.getText(source));
    return;
  }
  if (callee.name.text === "kill") add(node, "member-kill", callee.getText(source));
  if (ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text) && LAUNCH_APIS.has(callee.name.text)) {
    add(node, `child-process-${callee.name.text}`, callee.getText(source));
  }
  if (moduleCall(unwrapImport(callee.expression)) && LAUNCH_APIS.has(callee.name.text)) {
    add(node, `child-process-${callee.name.text}`, callee.getText(source));
  }
}

function auditPowerShell(file: string, text: string): Finding[] {
  const relativeFile = relative(SOURCE_ROOT, file).replaceAll("\\", "/");
  return text.split(/\r?\n/).flatMap((line, index) => {
    const findings: Finding[] = [];
    if (/\b(?:Start-Process|Invoke-Expression|cmd(?:\.exe)?\s+\/c|taskkill(?:\.exe)?)\b/i.test(line)) {
      findings.push({ file: relativeFile, line: index + 1, container: "<powershell>", kind: "powershell-process-launch", detail: line.trim() });
    }
    return findings;
  });
}
function packageFindings(): Finding[] {
  const findings: Finding[] = [];
  for (const packagePath of [join(REPOSITORY_ROOT, "runner-v2", "package.json"), join(REPOSITORY_ROOT, "package.json")]) {
    const file = relative(REPOSITORY_ROOT, packagePath).replaceAll("\\", "/");
    const value = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string>; bin?: string | Record<string, string> };
    for (const [name, script] of Object.entries(value.scripts ?? {})) {
      if (file === "package.json" && !/runner-v2|aiboard-runner/i.test(`${name}\n${script}`)) continue;
      if (/\b(?:taskkill|powershell|pwsh)(?:\.exe)?\b|\.ps1\b|\bcmd(?:\.exe)?\s+\/c\b/i.test(script)) {
        findings.push({ file, line: 0, container: `script:${name}`, kind: "package-launcher", detail: script });
      }
    }
    const bins = typeof value.bin === "string" ? { default: value.bin } : value.bin ?? {};
    for (const [name, target] of Object.entries(bins)) if (/\.ps1$/i.test(target)) {
      findings.push({ file, line: 0, container: `bin:${name}`, kind: "package-launcher", detail: target });
    }
  }
  return findings;
}

test("Task 8 production tree has no raw execution or ambient environment escape outside exact hosts", () => {
  const findings = [...sourceFiles(SOURCE_ROOT).flatMap(auditSource), ...packageFindings()];
  const matchedRules = new Set<number>();
  const allowed = (finding: Finding): boolean => {
    if (finding.kind === "ambient-process-env") return finding.file === "native-build-factory.ts";
    if (finding.file === "managed-process-job-host.ps1" && finding.kind === "powershell-process-launch") return true;
    const index = RAW_EXECUTION_ALLOWLIST.findIndex((rule) =>
      rule.file === finding.file && rule.container === finding.container && rule.kinds.includes(finding.kind));
    if (index < 0) return false;
    matchedRules.add(index);
    return true;
  };
  const violations = findings.filter((finding) => !allowed(finding));
  assert.deepEqual(violations, [], violations.map((finding) =>
    `${finding.file}:${finding.line} ${finding.container} ${finding.kind} ${finding.detail}`).join("\n"));
  const stale = RAW_EXECUTION_ALLOWLIST.filter((_rule, index) => !matchedRules.has(index));
  assert.deepEqual(stale, [], `Raw execution exceptions must remain exact and live:\n${stale.map((rule) =>
    `${rule.file} ${rule.container} ${rule.kinds.join(",")} — ${rule.reason}`).join("\n")}`);
});


test("Task 8 configured provider inventory has no local child-process transport", () => {
  const providerPath = join(SOURCE_ROOT, "provider-config-store.ts");
  const providerSource = ts.createSourceFile(providerPath, readFileSync(providerPath, "utf8"), ts.ScriptTarget.Latest, true);
  let transports: string[] | undefined;
  for (const statement of providerSource.statements) {
    if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== "ProviderTransport") continue;
    const members = ts.isUnionTypeNode(statement.type) ? statement.type.types : [statement.type];
    transports = members.map((member) => {
      assert.ok(ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal), "ProviderTransport must remain a closed string-literal union");
      return member.literal.text;
    });
  }
  assert.deepEqual(transports, ["account-runner", "openai-compatible", "anthropic", "google"]);

  const factory = readFileSync(join(SOURCE_ROOT, "native-build-factory.ts"), "utf8");
  for (const transport of ["account-runner", "anthropic", "google"]) {
    assert.match(factory, new RegExp(`config\\.transport === ["']${transport}["']`));
  }
  assert.match(factory, /return new OpenAICompatibleModel\(/, "the closed union's remaining openai-compatible transport stays the default API-model branch");
  for (const constructorName of ["AccountRunnerModel", "OpenAICompatibleModel", "AnthropicModel", "GoogleModel"]) {
    assert.match(factory, new RegExp(`new ${constructorName}\\(`));
  }
  for (const file of ["account-runner-model.ts", "openai-compatible-model.ts", "anthropic-model.ts", "google-model.ts"]) {
    const source = readFileSync(join(SOURCE_ROOT, file), "utf8");
    assert.doesNotMatch(source, /(?:node:)?child_process|\b(?:spawn|execFile|exec|fork)\s*\(/, `${file} must remain an API/HTTP model transport, not a local child launcher`);
  }
});
