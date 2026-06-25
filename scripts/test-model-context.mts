/** Model context profile checks (run: npx tsx scripts/test-model-context.mts) */
import {
  DEFAULT_MODEL_CONTEXT_PROFILE,
  MIN_CONTEXT_WINDOW_TOKENS,
  resolveModelContextProfile,
  type ModelContextOverrides,
} from "../lib/providers/model-context";
import { formatModelContextIndicator } from "../components/ModelSelector";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const known = resolveModelContextProfile("gemini-3.5-flash", "google");
check(
  "known model resolves to configured context size",
  known.contextWindowTokens === 1_048_576 &&
    known.outputReserveTokens === 65_536 &&
    known.longContextBehavior === "very_large" &&
    known.source === "registry",
  known
);

const unknownKnownProvider = resolveModelContextProfile("new-frontier-model", "openai");
check(
  "unknown model resolves to provider default profile",
  unknownKnownProvider.contextWindowTokens === 128_000 &&
    unknownKnownProvider.outputReserveTokens === 16_384 &&
    unknownKnownProvider.longContextBehavior === "large" &&
    unknownKnownProvider.source === "provider-default",
  unknownKnownProvider
);

const unknownProvider = resolveModelContextProfile("anything", "unlisted");
check(
  "unknown provider resolves to safe default profile",
  unknownProvider.contextWindowTokens === DEFAULT_MODEL_CONTEXT_PROFILE.contextWindowTokens &&
    unknownProvider.outputReserveTokens === DEFAULT_MODEL_CONTEXT_PROFILE.outputReserveTokens &&
    unknownProvider.longContextBehavior === DEFAULT_MODEL_CONTEXT_PROFILE.longContextBehavior &&
    unknownProvider.source === "default",
  unknownProvider
);

const overrides: ModelContextOverrides = {
  "google:gemini-3.5-flash": {
    contextWindowTokens: 777_000,
    outputReserveTokens: 12_345,
    longContextBehavior: "large",
    updatedAt: "2026-06-25T00:00:00.000Z",
  },
};
const overridden = resolveModelContextProfile("gemini-3.5-flash", "google", overrides);
check(
  "override wins over static registry",
  overridden.contextWindowTokens === 777_000 &&
    overridden.outputReserveTokens === 12_345 &&
    overridden.longContextBehavior === "large" &&
    overridden.source === "override",
  overridden
);

const invalidOverrides: ModelContextOverrides = {
  "google:gemini-3.5-flash": {
    contextWindowTokens: Number.NaN,
    outputReserveTokens: 999_999_999,
    longContextBehavior: "impossible" as never,
    updatedAt: "2026-06-25T00:00:00.000Z",
  },
};
const invalid = resolveModelContextProfile(
  "gemini-3.5-flash",
  "google",
  invalidOverrides
);
check(
  "invalid overrides are ignored or clamped safely",
  invalid.contextWindowTokens === known.contextWindowTokens &&
    invalid.outputReserveTokens <= 128_000 &&
    invalid.outputReserveTokens <= Math.floor(invalid.contextWindowTokens / 2) &&
    invalid.longContextBehavior === known.longContextBehavior &&
    invalid.source === "override",
  invalid
);

const tinyOverride = resolveModelContextProfile("local", "custom", {
  "custom:local": {
    contextWindowTokens: 1,
    outputReserveTokens: 99_999,
  },
});
check(
  "tiny invalid context is clamped to minimum and reserve cannot exceed half",
  tinyOverride.contextWindowTokens === MIN_CONTEXT_WINDOW_TOKENS &&
    tinyOverride.outputReserveTokens === Math.floor(MIN_CONTEXT_WINDOW_TOKENS / 2),
  tinyOverride
);

check(
  "model selector formats compact context indicator",
  formatModelContextIndicator(known) === "1.0M ctx / 65.5k out",
  formatModelContextIndicator(known)
);

process.exit(failed === 0 ? 0 : 1);
