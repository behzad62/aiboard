import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

function productionFiles(dir: string): string[] {
  const abs = path.join(root, dir);
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    const full = path.join(abs, entry);
    const rel = path.relative(root, full).replaceAll("\\", "/");
    if (statSync(full).isDirectory()) {
      out.push(...productionFiles(rel));
    } else if (/\.(?:ts|tsx|mjs)$/.test(entry)) {
      out.push(rel);
    }
  }
  return out;
}

assert.equal(
  existsSync(path.join(root, "lib/providers/legacy-tool-intents.ts")),
  false,
  "legacy tool-intent compatibility bridge must be deleted",
);

const base = read("lib/providers/base.ts");
for (const field of ["webSearch", "nativeTools", "hostedTools", "hostedBuildTools"]) {
  assert.doesNotMatch(base, new RegExp(`\\b${field}\\?\\s*:`), `ChatParams must not expose ${field}`);
}
assert.match(base, /functionTools\?\s*:\s*NativeToolDefinition\[\]/);

const registry = read("lib/providers/provider-registry.ts");
for (const symbol of [
  "MODEL_TOOL_SUPPORT",
  "providerSupportsNativeWebSearchFeature",
  "providerSupportsNativeBuildToolsFeature",
  "providerSupportsHostedBuildToolsFeature",
]) {
  assert.doesNotMatch(registry, new RegExp(`\\b${symbol}\\b`), `${symbol} must not remain provider truth`);
}

const webSearch = read("lib/providers/web-search.ts");
assert.doesNotMatch(webSearch, /shouldEnableProviderNativeWebSearch/);
assert.match(webSearch, /webSearchToolIntent/);

const runtimeFiles = [
  ...productionFiles("lib/providers"),
  ...productionFiles("lib/client"),
  "lib/account-provider-runner.mjs",
  "lib/account-provider-copilot-sdk.mjs",
];
const forbiddenPatterns: Array<[RegExp, string]> = [
  [/legacy-tool-intents/, "legacy tool-intent bridge import"],
  [/\bparams\.webSearch\b/, "ChatParams.webSearch read"],
  [/\bparams\.nativeTools\b/, "ChatParams.nativeTools read"],
  [/\bparams\.hostedTools\b/, "ChatParams.hostedTools read"],
  [/\bparams\.hostedBuildTools\b/, "ChatParams.hostedBuildTools read"],
  [/\bbody\.webSearch\b/, "account-runner webSearch wire field"],
  [/\bbody\.nativeTools\b/, "account-runner nativeTools wire field"],
  [/\bnativeTools\s*:/, "legacy nativeTools request property"],
  [/\bhostedBuildTools\s*:/, "legacy hostedBuildTools request property"],
];
for (const file of runtimeFiles) {
  const source = read(file);
  for (const [pattern, label] of forbiddenPatterns) {
    assert.doesNotMatch(source, pattern, `${file}: ${label}`);
  }
}
console.log("PASS provider runtime contains no legacy request/truth symbols");

const nativeBuild = read("lib/client/native-build-engine.ts");
assert.doesNotMatch(
  nativeBuild,
  /hostedTools\s*:\s*\[[\s\S]*?type:\s*["']shell["']/,
  "native Build must not inject provider-hosted shell into repo execution",
);
const worker = read("runner-v2/src/native-worker-driver.ts");
assert.doesNotMatch(
  worker,
  /hostedTools\s*:\s*\[\{\s*type:\s*["']apply_patch["']/,
  "native worker must use AI Board local edit tools instead of provider-hosted apply_patch",
);
console.log("PASS native Build keeps local shell/edit/test execution authoritative");

console.log("PASS");
