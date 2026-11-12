/**
 * No provider SDK client or provider fetch outside the resolver (Simple Build plan §9, packet HM4a).
 * Run: npx tsx scripts/test-no-direct-provider-calls.mts
 *
 * Every browser model call takes its address and token from `resolveProviderConnection`
 * (lib/client/providers.ts): the Runner's model proxy, or the account peer for ChatGPT and Copilot.
 * A client built anywhere else could send a proxy token, or a key, straight to a provider. This scan of
 * the web code (lib/, components/, app/) fails when:
 *
 * 1. a provider SDK client (`new OpenAI(`, `new Anthropic(`, `new GoogleGenAI(`, ...) is built outside
 *    lib/providers/connection.ts, or an SDK client class is imported as a value anywhere else;
 * 2. code names a provider's API base (from the provider registry, plus Azure Foundry's host) outside the
 *    registry, except the keyless OpenRouter public catalog (settings-api.ts);
 * 3. `fetch(` appears in a file that is not on the reviewed list below (each entry says what it calls),
 *    or `XMLHttpRequest`/`EventSource` appears at all;
 * 4. a live module imports one of the dead server-era provider modules, which still build their own
 *    clients (CLAUDE.md "Legacy server-era modules").
 *
 * A self-test feeds the scanner each forbidden shape first, so a scanner that matches nothing fails.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

import { PROVIDER_DEFINITIONS } from "../lib/providers/provider-registry";

const ROOT = join(import.meta.dirname, "..");
const SCANNED_DIRECTORIES = ["lib", "components", "app"];
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/;

/** The one module that builds SDK clients and raw provider requests. */
const RESOLVER_MODULE = "lib/providers/connection.ts";

/** Dead server-era modules (CLAUDE.md): never imported by live code, so excluded from rules 1-3. */
const DEAD_MODULES = new Set(["lib/providers/custom.ts", "lib/providers/index.ts", "lib/orchestrator/engine.ts"]);
/** The dead modules that build provider clients; lib/orchestrator/engine.ts may be imported for its type only. */
const DEAD_PROVIDER_IMPORTS = new Set(["lib/providers/custom", "lib/providers/index", "lib/providers"]);

/** An import specifier as a repo path without extension, or null for a package. */
function resolveSpecifier(file: string, specifier: string): string | null {
  let path: string;
  if (specifier.startsWith("@/")) path = specifier.slice(2);
  else if (specifier.startsWith(".")) path = posix.normalize(posix.join(posix.dirname(file), specifier));
  else return null;
  return path.replace(/\.(?:ts|tsx|mts|js|mjs)$/, "").replace(/\/$/, "");
}

/** Files that may call `fetch(`, and what they call. None of them reaches a provider. */
const FETCH_ALLOWED: Record<string, string> = {
  "lib/providers/connection.ts": "the resolver's raw provider request (providerFetch), to the resolved connection only",
  "lib/client/model-proxy-client.ts": "the launcher's control port (health, proxy-session) and the proxy port",
  "lib/client/home-client.ts": "the launcher's control port: GET and POST /v2/home (settings and keys, never a provider)",
  "lib/client/settings-api.ts": "the keyless OpenRouter public catalog, and the account peer's ChatGPT status and model list",
  "lib/providers/account-runner.ts": "the account peer (ChatGPT, Copilot) at the launcher's address",
  "lib/providers/runner-capabilities.ts": "the account peer's capability handshake",
  "components/ApiKeyForm.tsx": "the account peer's sign-in routes",
  "lib/client/runner.ts": "the legacy local runner (benchmark only)",
  "lib/client/repo-runner.ts": "the legacy local runner's repo routes (benchmark only)",
  "lib/client/bench-runner.ts": "the WorkBench bench runner",
  "lib/client/runner-extensions.ts": "the Runner's control port (extensions)",
  "lib/client/model-metadata-enrichment.ts": "models.dev, a public metadata catalog (not a provider, no key)",
  "lib/benchmark/toolreliability/native-cases.ts": "fixture page source a benchmark case serves to itself (a string, not a call)",
};

/** The public, keyless OpenRouter catalog stays a direct call (plan §9). */
const ALLOWED_PROVIDER_URLS: Record<string, string[]> = {
  "lib/client/settings-api.ts": ["https://openrouter.ai/api/v1/models"],
};

const SDK_PACKAGES = ["openai", "@anthropic-ai/sdk", "@anthropic-ai/foundry-sdk", "@google/genai", "@google/generative-ai"];
const SDK_CLIENT_CLASSES = ["OpenAI", "AzureOpenAI", "Anthropic", "AnthropicFoundry", "GoogleGenAI", "GoogleGenerativeAI"];

function providerApiBases(): string[] {
  const bases = new Set<string>();
  for (const definition of Object.values(PROVIDER_DEFINITIONS) as Array<{ connection?: { defaultBaseUrl?: string | null } }>) {
    const base = definition.connection?.defaultBaseUrl;
    if (base) bases.add(base.replace(/\/+$/, ""));
  }
  bases.add("services.ai.azure.com/anthropic");
  return [...bases];
}

export interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

function stripComments(source: string): string {
  // Keep line numbers: replace comment bodies with spaces, leave newlines.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (match, lead: string) => lead + " ".repeat(match.length - lead.length));
}

export function scanSource(file: string, source: string, bases = providerApiBases()): Violation[] {
  const violations: Violation[] = [];
  const code = stripComments(source);
  const lines = code.split("\n");
  const at = (index: number) => code.slice(0, index).split("\n").length;
  const push = (index: number, rule: string) => {
    const line = at(index);
    violations.push({ file, line, rule, text: (lines[line - 1] ?? "").trim().slice(0, 160) });
  };

  if (file !== RESOLVER_MODULE) {
    const construct = new RegExp(`\\bnew\\s+(?:${SDK_CLIENT_CLASSES.join("|")})\\s*\\(`, "g");
    for (const match of code.matchAll(construct)) push(match.index!, "SDK client built outside the resolver");

    const imports = /import\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g;
    for (const match of code.matchAll(imports)) {
      const [, wholeType, clause, specifier] = match;
      if (!SDK_PACKAGES.includes(specifier!) || wholeType) continue;
      const defaultImport = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause!)?.[1];
      const named = /\{([^}]*)\}/.exec(clause!)?.[1] ?? "";
      const valueNames = named.split(",").map((part) => part.trim()).filter((part) => part && !part.startsWith("type "))
        .map((part) => part.split(/\s+as\s+/)[0]!.trim());
      if (defaultImport || valueNames.some((name) => SDK_CLIENT_CLASSES.includes(name))) {
        push(match.index!, `SDK client class imported as a value from ${specifier} outside the resolver`);
      }
    }
  }

  const allowedUrls = ALLOWED_PROVIDER_URLS[file] ?? [];
  if (!file.endsWith("lib/providers/provider-registry.ts")) {
    const literals = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
    for (const match of code.matchAll(literals)) {
      const value = match[2]!;
      if (allowedUrls.includes(value)) continue;
      if (bases.some((base) => value.includes(base))) push(match.index!, "provider API base named outside the provider registry");
    }
  }

  if (!(file in FETCH_ALLOWED)) {
    for (const match of code.matchAll(/(?<![\w$.])fetch\s*\(/g)) push(match.index!, "fetch( in a file not on the reviewed list");
  }
  for (const match of code.matchAll(/\b(?:XMLHttpRequest|EventSource)\b/g)) push(match.index!, "XMLHttpRequest/EventSource");

  for (const match of code.matchAll(/(?:import|from)\s*\(?\s*["']([^"']+)["']/g)) {
    const target = resolveSpecifier(file, match[1]!);
    if (!target) continue;
    if (DEAD_PROVIDER_IMPORTS.has(target)) push(match.index!, `imports a dead server-era provider module (${match[1]})`);
    if (target === "lib/orchestrator/engine") {
      const start = Math.max(code.lastIndexOf("import", match.index!), code.lastIndexOf("export", match.index!));
      const statement = code.slice(start, match.index! + match[0].length);
      if (!/^(?:import|export)\s+type\b/.test(statement)) push(match.index!, "imports lib/orchestrator/engine for more than its OrchestratorEvent type");
    }
  }
  return violations;
}

function walk(directory: string, out: string[]): void {
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (SOURCE_FILE.test(name)) out.push(path);
  }
}

// ---------------------------------------------------------------- self-test

{
  const forbidden: Array<[string, string]> = [
    ["SDK client built outside the resolver", `const client = new OpenAI({ apiKey });`],
    ["SDK client built outside the resolver", `const c = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });`],
    ["SDK client built outside the resolver", `const g = new GoogleGenAI({ apiKey });`],
    ["SDK client class imported as a value from openai", `import OpenAI from "openai";`],
    ["SDK client class imported as a value from @google/genai", `import { GoogleGenAI, type Content } from "@google/genai";`],
    ["provider API base named outside the provider registry", `await fetch("https://api.openai.com/v1/models");`],
    ["provider API base named outside the provider registry", "const url = `https://api.x.ai/v1/language-models`;"],
    ["provider API base named outside the provider registry", `const base = "https://integrate.api.nvidia.com/v1";`],
    ["provider API base named outside the provider registry", `const base = "https://my-resource.services.ai.azure.com/anthropic/";`],
    ["fetch( in a file not on the reviewed list", `const r = await fetch(url);`],
    ["XMLHttpRequest/EventSource", `const x = new XMLHttpRequest();`],
    ["imports a dead server-era provider module", `import { streamCustomChat } from "../providers/custom";`],
    ["imports lib/orchestrator/engine for more than its OrchestratorEvent type", `import { runDiscussion } from "@/lib/orchestrator/engine";`],
  ];
  for (const [rule, source] of forbidden) {
    const found = scanSource("lib/client/example.ts", source);
    assert.ok(found.some((violation) => violation.rule.startsWith(rule)), `the scanner catches: ${source}`);
  }
  const allowed = [
    `import type OpenAI from "openai";`,
    `import { FunctionCallingConfigMode, type GoogleGenAI } from "@google/genai";`,
    `import type { OrchestratorEvent } from "@/lib/orchestrator/engine";`,
    `export type { OrchestratorEvent } from "@/lib/orchestrator/engine";`,
    `import { getProvider } from "./providers";`,
    `// new OpenAI({ apiKey }) in a comment`,
    `const docs = "https://developers.openai.com/api/docs/models";`,
    `const page = "https://openrouter.ai/qwen/qwen3.7-max";`,
  ];
  for (const source of allowed) {
    assert.deepEqual(scanSource("lib/client/example.ts", source), [], `the scanner allows: ${source}`);
  }
  assert.deepEqual(scanSource("lib/client/settings-api.ts", `await fetch("https://openrouter.ai/api/v1/models");`), [], "the keyless OpenRouter catalog stays direct");
  assert.equal(scanSource(RESOLVER_MODULE, `return new OpenAI({ apiKey: c.apiKey, baseURL: c.baseURL });`).length, 0, "the resolver module may build clients");
  console.log(`PASS the scanner catches ${forbidden.length} forbidden shapes and allows ${allowed.length + 2} safe ones`);
}

// ---------------------------------------------------------------- the web code

const files: string[] = [];
for (const directory of SCANNED_DIRECTORIES) walk(join(ROOT, directory), files);
const violations: Violation[] = [];
let scanned = 0;
for (const path of files) {
  const file = relative(ROOT, path).split(sep).join("/");
  if (DEAD_MODULES.has(file)) continue;
  scanned += 1;
  violations.push(...scanSource(file, readFileSync(path, "utf8")));
}
for (const file of Object.keys(FETCH_ALLOWED)) {
  assert.ok(files.some((path) => relative(ROOT, path).split(sep).join("/") === file), `the reviewed fetch list names a file that no longer exists: ${file}`);
}
if (violations.length > 0) {
  for (const violation of violations) console.error(`FAIL ${violation.file}:${violation.line} ${violation.rule}: ${violation.text}`);
  console.error(`FAIL ${violations.length} direct provider call(s); route them through resolveProviderConnection (lib/client/providers.ts).`);
  process.exit(1);
}
console.log(`PASS no provider SDK client or provider fetch outside the resolver (${scanned} files in ${SCANNED_DIRECTORIES.join(", ")})`);
