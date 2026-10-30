// What a Runner release bundle ships besides Node, and a closure check over it: every module that a shipped
// source file imports must itself be shipped (a relative file in the bundle, a declared runtime package, or a
// Node built-in). The build refuses a bundle with a gap, so a peer helper such as the Copilot SDK adapter
// cannot be left out again.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { posix } from "node:path";

/** Runtime npm dependencies of Runner V2 and the peer runners; everything else is resolved from the lockfile. */
export const RUNTIME_PACKAGES = ["@github/copilot-sdk", "@modelcontextprotocol/sdk", "playwright", "typescript"];
/** Peer runners started by `aiboard accounts` / `aiboard legacy` (launcher.ts peerEntries). The bench runner needs its own pinned runtime and stays a separate download. */
export const PEER_FILES = [
  "lib/account-provider-runner.mjs",
  "lib/account-provider-copilot-sdk.mjs",
  "scripts/local-pair-runner.mjs",
  "scripts/runner.mjs",
  "scripts/runner-lib.mjs",
  "scripts/runner-panel.html",
  "scripts/runner-help.html",
];
export const LEGAL_FILES = ["LICENSE", "NOTICE", "TRADEMARKS.md"];
/** Imports that are guarded fallbacks and deliberately not shipped (file -> specifiers). */
const OPTIONAL_IMPORTS: Record<string, readonly string[]> = {
  // Tries ../scripts/local-pair-runner.mjs first (shipped); ./local-pair-runner.mjs is the flat standalone-download layout.
  "lib/account-provider-runner.mjs": ["./local-pair-runner.mjs"],
};

const SPECIFIER = /(?:^|[^.\w$])(?:import|export)\s+(type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?["']([^"']+)["']|(?:^|[^.\w$])(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gm;

/** Runtime module specifiers of one source file (type-only imports and non-literal dynamic imports are skipped). */
export function importSpecifiers(source: string): string[] {
  const found = new Set<string>();
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const match of code.matchAll(SPECIFIER)) {
    if (match[1]) continue;
    const specifier = match[2] ?? match[3];
    if (specifier) found.add(specifier);
  }
  return [...found];
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Shipped source files mapped to the bundle-relative module they become (.ts sources ship as .js). */
export function shippedSources(root: string, peerFiles: readonly string[] = PEER_FILES): Map<string, string> {
  const tracked = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--", "runner-v2/src", ...peerFiles], { encoding: "utf8" })
    .split("\0").filter(Boolean);
  const sources = new Map<string, string>();
  for (const path of tracked) {
    if (path.endsWith(".d.ts") || path.endsWith(".d.mts")) continue;
    if (/\.(ts|mts|mjs|js|cjs)$/.test(path)) sources.set(path, path.replace(/\.ts$/, ".js"));
  }
  return sources;
}

/** Describes every import in a shipped file that the bundle cannot satisfy. */
export function importClosureGaps(root: string, contents: { peerFiles?: readonly string[]; runtimePackages?: readonly string[] } = {}): string[] {
  const peerFiles = contents.peerFiles ?? PEER_FILES;
  const runtimePackages = contents.runtimePackages ?? RUNTIME_PACKAGES;
  const sources = shippedSources(root, peerFiles);
  const shipped = new Set([...sources.values(), ...peerFiles]);
  const builtins = new Set(builtinModules);
  const gaps: string[] = [];
  for (const [path, module] of sources) {
    for (const specifier of importSpecifiers(readFileSync(posix.join(root, path), "utf8"))) {
      if (OPTIONAL_IMPORTS[path]?.includes(specifier)) continue;
      if (specifier.startsWith("node:") || builtins.has(specifier)) continue;
      if (specifier.startsWith(".")) {
        const target = posix.normalize(posix.join(posix.dirname(module), specifier));
        if (!shipped.has(target)) gaps.push(`${path} imports ${specifier}, which is not in the bundle`);
      } else if (!runtimePackages.includes(packageName(specifier))) {
        gaps.push(`${path} imports package ${packageName(specifier)}, which is not a declared runtime package`);
      }
    }
  }
  return gaps;
}
