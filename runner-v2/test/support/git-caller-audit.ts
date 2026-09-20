import * as ts from "typescript";

/** Task8.1 Git-family boundary only. Whole-Runner platform hosts and the other
 * process families remain subject to their separate Task8.2-8.5 migrations. */
export const GIT_FAMILY_MODULES = Object.freeze([
  "git-command.ts", "git-runtime-runner.ts", "git-run-context.ts", "git-bootstrap.ts", "git-preflight.ts",
  "git-baseline.ts", "git-repository.ts", "git-tools.ts", "workspace-manager.ts", "integration-manager.ts",
  "change-set.ts", "repository-intelligence.ts", "verification-workspace.ts", "final-verification-profile.ts",
  "final-verification-cleanup.ts", "final-verification-runtime.ts", "native-worker-driver.ts", "worker-runtime.ts",
  "native-architect-runtime.ts", "native-verifier-runtime.ts", "subagent-tools.ts", "evidence-tools.ts", "tool-broker.ts",
]);
export interface GitBoundaryFinding { file: string; line: number; reason: string }
export function auditGitFamilySource(text: string, file: string): GitBoundaryFinding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const findings: GitBoundaryFinding[] = [];
  const add = (node: ts.Node, reason: string) => {
    findings.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, reason });
  };
  const childModule = (node: ts.Node | undefined) => !!node && ts.isStringLiteralLike(node) && /^(?:node:)?child_process$/.test(node.text);
  const member = (node: ts.Node): { target: ts.Expression; name: string } | undefined => {
    if (ts.isPropertyAccessExpression(node)) return { target: node.expression, name: node.name.text };
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression))
      return { target: node.expression, name: node.argumentExpression.text };
    return undefined;
  };
  const nonGitPackageDiscovery = (node: ts.Node): boolean => {
    // This pre-existing npm/corepack command-discovery code does not execute
    // Git or construct its child environment. Task8.5 owns the later whole-
    // Runner environment audit; do not exempt the entire profile module.
    if (file !== "final-verification-profile.ts" || member(node.parent)?.name !== "npm_execpath") return false;
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionDeclaration(parent)) return parent.name?.text === "npmInvocation" || parent.name?.text === "packageManagerInvocation";
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && childModule(node.moduleSpecifier)) add(node, "raw process module in migrated Git family");
    const access = member(node);
    if (access?.name === "env" && ts.isIdentifier(access.target) && access.target.text === "process" && !nonGitPackageDiscovery(node)) add(node, "ambient process environment");
    if (ts.isCallExpression(node)) {
      if ((node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require") && childModule(node.arguments[0]))
        add(node, "dynamic raw process module");
      if (member(node.expression)?.name === "kill") add(node, "private or numeric process termination");
    }
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : "";
      if (name === "shell" && node.initializer.kind === ts.SyntaxKind.TrueKeyword) add(node, "shell execution");
      if (name === "executable" && ts.isStringLiteralLike(node.initializer) && /(?:^|[\\/])(?:powershell|pwsh|taskkill)(?:\.exe)?$/i.test(node.initializer.text))
        add(node, "OS command launcher outside the shared host");
    }
    ts.forEachChild(node, visit);
  };
  visit(source); return findings;
}
