/**
 * Writes runner-v2/src/generated/model-catalog.ts, the Runner's copy of the web's model knowledge
 * (Simple Build plan §9 "The Runner knows models", packet HM2, OD-30): the catalog entries, each
 * provider's default base URL and transport, pricing, context profiles, the renamed model ids and
 * OpenRouter's function-tool rule. Runner code never imports from lib/, and the release bundle ships
 * only git-tracked source files, so the copy is a committed, data-only TypeScript module.
 *
 *   npx tsx scripts/generate-runner-model-catalog.mts          # rewrite the file
 *   npx tsx scripts/generate-runner-model-catalog.mts --check  # fail when the committed file is stale
 *
 * Function-valued rules (reasoning-effort support, the account API-equivalent pricing rule, `#effort`
 * stripping) are ported as code in runner-v2/src/home-model-policy.ts, under
 * scripts/test-runner-model-catalog-parity.mts.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getProviderCapabilityManifest } from "../lib/providers/capability-manifests";
import { MODEL_CATALOG } from "../lib/providers/catalog";
import {
  DEFAULT_MODEL_CONTEXT_PROFILE,
  MAX_CONTEXT_WINDOW_TOKENS,
  MAX_OUTPUT_TOKENS,
  MIN_CONTEXT_WINDOW_TOKENS,
  MIN_OUTPUT_TOKENS,
  MODEL_CONTEXT_PROFILES,
  PROVIDER_DEFAULT_CONTEXT_PROFILES,
} from "../lib/providers/model-context";
import { OPENAI_LEGACY_MODEL_IDS } from "../lib/providers/model-id-migration";
import { MODEL_PRICING } from "../lib/providers/pricing";
import { PROVIDER_DEFINITIONS, PROVIDER_IDS } from "../lib/providers/provider-registry";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const RUNNER_MODEL_CATALOG_PATH = join(ROOT, "runner-v2", "src", "generated", "model-catalog.ts");

/** Sorts object keys recursively, so the output and its hash never depend on insertion order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function functionCallingRule(providerId: string) {
  const manifest = getProviderCapabilityManifest(providerId);
  const descriptor = manifest?.capabilities.find((entry) => entry.id === "function_calling");
  if (!manifest || !descriptor) throw new Error(`The ${providerId} capability manifest has no function_calling entry.`);
  return {
    defaultSupport: descriptor.support,
    prerequisiteIds: (descriptor.prerequisites ?? []).map((prerequisite) => prerequisite.id),
    rules: (manifest.modelRules ?? []).flatMap((rule) => {
      const patch = rule.capabilities.function_calling;
      if (!patch?.support) return [];
      return [{
        ...(rule.modelId !== undefined ? { modelId: rule.modelId } : {}),
        ...(rule.modelPattern !== undefined ? { modelPattern: { source: rule.modelPattern.source, flags: rule.modelPattern.flags } } : {}),
        support: patch.support,
      }];
    }),
  };
}

export function buildRunnerModelCatalogSnapshot() {
  const providers = Object.fromEntries(PROVIDER_IDS.map((id) => {
    const definition = PROVIDER_DEFINITIONS[id];
    return [id, {
      id,
      name: definition.name,
      modelSource: definition.modelSource,
      modelDiscovery: "modelDiscovery" in definition && definition.modelDiscovery ? definition.modelDiscovery.source : null,
      accountBacked: "accountRunner" in definition && definition.accountRunner !== undefined,
      transport: definition.connection.transport,
      defaultBaseUrl: definition.connection.defaultBaseUrl,
      protocol: "protocol" in definition.connection ? definition.connection.protocol ?? null : null,
      reasoningEffort: typeof definition.reasoningEffort === "function" ? "model-rule" : definition.reasoningEffort,
      maxTokens: typeof definition.maxTokens === "function" ? "model-rule" : definition.maxTokens,
    }];
  }));
  const body = canonical({
    // Object keys are sorted below; this keeps the registry's provider order, which model lists follow.
    providerOrder: [...PROVIDER_IDS],
    providers,
    models: MODEL_CATALOG,
    pricing: MODEL_PRICING,
    contextProfiles: {
      default: DEFAULT_MODEL_CONTEXT_PROFILE,
      providers: PROVIDER_DEFAULT_CONTEXT_PROFILES,
      models: MODEL_CONTEXT_PROFILES,
      limits: {
        minContextWindowTokens: MIN_CONTEXT_WINDOW_TOKENS,
        maxContextWindowTokens: MAX_CONTEXT_WINDOW_TOKENS,
        minOutputTokens: MIN_OUTPUT_TOKENS,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
    },
    modelIdMigrations: { openai: OPENAI_LEGACY_MODEL_IDS },
    functionCalling: { openrouter: functionCallingRule("openrouter") },
  }) as Record<string, unknown>;
  // Model order is the web's (the catalog's array order is meaningful); canonical() keeps arrays as they are.
  const catalogVersion = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return { catalogVersion, ...body };
}

export function renderRunnerModelCatalog(): string {
  const snapshot = buildRunnerModelCatalogSnapshot();
  return [
    "// Generated by scripts/generate-runner-model-catalog.mts from lib/providers: catalog.ts, provider-registry.ts,",
    "// pricing.ts, model-context.ts, model-id-migration.ts and capability-manifests.ts. Do not edit it by hand:",
    "// rerun the script after changing those files. `--check` fails on a stale copy (CI: runner-bundle-closure.yml).",
    "// Data only: runner-v2/src/home-model-policy.ts holds the rules that are code.",
    "",
    `export const MODEL_CATALOG_SNAPSHOT = ${JSON.stringify(snapshot, null, 2)} as const;`,
    "",
    "export const catalogVersion: string = MODEL_CATALOG_SNAPSHOT.catalogVersion;",
    "",
  ].join("\n");
}

/** Line endings aside: a Windows checkout with core.autocrlf holds CRLF. */
function normalized(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function runnerModelCatalogIsCurrent(path = RUNNER_MODEL_CATALOG_PATH): boolean {
  let committed: string;
  try { committed = readFileSync(path, "utf8"); } catch { return false; }
  return normalized(committed) === renderRunnerModelCatalog();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    // `--file <path>` checks another copy (the parity script uses it to prove a stale file fails).
    const fileIndex = process.argv.indexOf("--file");
    const path = fileIndex > 0 && process.argv[fileIndex + 1] ? process.argv[fileIndex + 1]! : RUNNER_MODEL_CATALOG_PATH;
    if (!runnerModelCatalogIsCurrent(path)) {
      console.error("FAIL runner-v2/src/generated/model-catalog.ts is stale: run `npx tsx scripts/generate-runner-model-catalog.mts` and commit the result.");
      process.exit(1);
    }
    console.log(`PASS runner model catalog is current (catalogVersion ${buildRunnerModelCatalogSnapshot().catalogVersion})`);
  } else {
    mkdirSync(dirname(RUNNER_MODEL_CATALOG_PATH), { recursive: true });
    writeFileSync(RUNNER_MODEL_CATALOG_PATH, renderRunnerModelCatalog());
    console.log(`Wrote runner-v2/src/generated/model-catalog.ts (catalogVersion ${buildRunnerModelCatalogSnapshot().catalogVersion})`);
  }
}
