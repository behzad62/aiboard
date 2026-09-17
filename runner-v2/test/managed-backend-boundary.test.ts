import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as ts from "typescript";
import { ManagedProcessService } from "../src/managed-process.js";

function source(name: string): string {
  return readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
}

for (const name of ["execution-host.ts", "native-build-factory.ts"]) {
  test(`managed composition passes only the extracted Job host to its backend: ${name}`, () => {
    const file = ts.createSourceFile(name, source(name), ts.ScriptTarget.Latest, true);
    const argumentsFound: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && node.expression.getText(file) === "WindowsJobObjectProcessBackend") {
        argumentsFound.push(node.arguments?.[0]?.getText(file) ?? "missing");
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    assert.ok(argumentsFound.length > 0, "the production Job registration must remain present");
    for (const argument of argumentsFound) assert.match(argument, /(?:^|\.)windowsJobHost$/, "a public managed facade cannot be an OS backend dependency");
  });
}

test("extracted Job adapter has no value dependency on the public managed facade", () => {
  for (const name of ["windows-job-process-host.ts", "windows-process-backend.ts", "windows-job-process-channel.ts"]) {
    const file = ts.createSourceFile(name, source(name), ts.ScriptTarget.Latest, true);
    const imports = file.statements.filter(ts.isImportDeclaration);
    assert.equal(imports.some(node => ts.isStringLiteral(node.moduleSpecifier) && /managed-process\.js$/.test(node.moduleSpecifier.text)), false, name);
  }
});

test("managed facade does not export an alternate backend launch or probe route", () => {
  for (const name of ["launchOwned", "signalOwned", "releaseOwned", "readOwnedOutput", "probeActiveJobCreateClose", "probeJobObjectAvailability"]) {
    assert.equal(name in ManagedProcessService.prototype, false, `${name} must belong exclusively to the extracted backend host`);
  }
});
