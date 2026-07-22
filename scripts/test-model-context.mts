/** Model context profile checks (run: npx tsx scripts/test-model-context.mts) */
import {
  DEFAULT_MODEL_CONTEXT_PROFILE,
  MIN_CONTEXT_WINDOW_TOKENS,
  resolveModelContextProfile,
  type ModelContextOverrides,
} from "../lib/providers/model-context";
import { formatModelContextIndicator } from "../lib/providers/model-context-format";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const known = resolveModelContextProfile("gemini-3.5-flash", "google");
check(
  "known model resolves to configured context size",
  known.contextWindowTokens === 1_048_576 &&
    known.maxOutputTokens === 65_536 &&
    known.buildOutputReserveTokens === 65_536 &&
    known.effectiveBuildInputCeilingTokens === 983_040 &&
    known.longContextQuality === "excellent" &&
    known.promptCaching === true &&
    known.recommendedBuildRoles?.includes("architect") &&
    known.source === "registry",
  known
);

const unknownKnownProvider = resolveModelContextProfile("new-frontier-model", "openai");
check(
  "unknown model resolves to provider default profile",
  unknownKnownProvider.contextWindowTokens === 128_000 &&
    unknownKnownProvider.maxOutputTokens === 16_384 &&
    unknownKnownProvider.buildOutputReserveTokens === 16_384 &&
    unknownKnownProvider.longContextQuality === "good" &&
    unknownKnownProvider.promptCaching === true &&
    unknownKnownProvider.source === "provider-default",
  unknownKnownProvider
);

const unknownProvider = resolveModelContextProfile("anything", "unlisted");
check(
  "unknown provider resolves to safe default profile",
  unknownProvider.contextWindowTokens === DEFAULT_MODEL_CONTEXT_PROFILE.contextWindowTokens &&
    unknownProvider.maxOutputTokens === DEFAULT_MODEL_CONTEXT_PROFILE.maxOutputTokens &&
    unknownProvider.buildOutputReserveTokens ===
      DEFAULT_MODEL_CONTEXT_PROFILE.buildOutputReserveTokens &&
    unknownProvider.longContextQuality === DEFAULT_MODEL_CONTEXT_PROFILE.longContextQuality &&
    unknownProvider.source === "default",
  unknownProvider
);

const overrides: ModelContextOverrides = {
  "google:gemini-3.5-flash": {
    contextWindowTokens: 777_000,
    maxOutputTokens: 20_000,
    buildOutputReserveTokens: 12_345,
    effectiveBuildInputCeilingTokens: 700_000,
    longContextQuality: "good",
    promptCaching: false,
    recommendedBuildRoles: ["worker", "summary"],
    updatedAt: "2026-06-25T00:00:00.000Z",
  },
};
const overridden = resolveModelContextProfile("gemini-3.5-flash", "google", overrides);
check(
  "override wins over static registry",
  overridden.contextWindowTokens === 777_000 &&
    overridden.maxOutputTokens === 20_000 &&
    overridden.buildOutputReserveTokens === 12_345 &&
    overridden.effectiveBuildInputCeilingTokens === 700_000 &&
    overridden.longContextQuality === "good" &&
    overridden.promptCaching === false &&
    overridden.recommendedBuildRoles?.join(",") === "worker,summary" &&
    overridden.source === "override",
  overridden
);

const invalidOverrides: ModelContextOverrides = {
  "google:gemini-3.5-flash": {
    contextWindowTokens: Number.NaN,
    maxOutputTokens: 999_999_999,
    buildOutputReserveTokens: 999_999_999,
    effectiveBuildInputCeilingTokens: 999_999_999,
    longContextQuality: "impossible" as never,
    promptCaching: "yes" as never,
    recommendedBuildRoles: ["worker", "unknown" as never],
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
    invalid.maxOutputTokens === 128_000 &&
    invalid.buildOutputReserveTokens <= 128_000 &&
    invalid.buildOutputReserveTokens <= Math.floor(invalid.contextWindowTokens / 2) &&
    invalid.effectiveBuildInputCeilingTokens ===
      invalid.contextWindowTokens - invalid.buildOutputReserveTokens &&
    invalid.longContextQuality === known.longContextQuality &&
    invalid.promptCaching === known.promptCaching &&
    invalid.recommendedBuildRoles?.join(",") === "worker" &&
    invalid.source === "override",
  invalid
);

const tinyOverride = resolveModelContextProfile("local", "custom", {
  "custom:local": {
    contextWindowTokens: 1,
    buildOutputReserveTokens: 99_999,
  },
});
check(
  "tiny invalid context is clamped to minimum and reserve cannot exceed half",
  tinyOverride.contextWindowTokens === MIN_CONTEXT_WINDOW_TOKENS &&
    tinyOverride.buildOutputReserveTokens === Math.floor(MIN_CONTEXT_WINDOW_TOKENS / 2) &&
    tinyOverride.effectiveBuildInputCeilingTokens === Math.floor(MIN_CONTEXT_WINDOW_TOKENS / 2),
  tinyOverride
);

const customOverride = resolveModelContextProfile("ollama-local", "custom", {
  "custom:ollama-local": {
    contextWindowTokens: 64_000,
    maxOutputTokens: 16_000,
    buildOutputReserveTokens: 8_000,
  },
});
check(
  "custom model override resolves by full custom model id",
  customOverride.fullModelId === "custom:ollama-local" &&
    customOverride.contextWindowTokens === 64_000 &&
    customOverride.maxOutputTokens === 16_000 &&
    customOverride.buildOutputReserveTokens === 8_000 &&
    customOverride.source === "override",
  customOverride
);

check(
  "model selector formats compact context indicator",
  formatModelContextIndicator(known) === "1.0M ctx / 65.5k reserve",
  formatModelContextIndicator(known)
);

const gpt55 = resolveModelContextProfile("gpt-5.5", "openai");
check(
  "OpenAI GPT-5.5 profile uses current documented context and max output",
  gpt55.contextWindowTokens === 1_050_000 &&
    gpt55.maxOutputTokens === 128_000 &&
    gpt55.buildOutputReserveTokens === 128_000,
  gpt55
);

for (const providerId of ["openai", "chatgpt"] as const) {
  for (const modelId of [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ] as const) {
    const profile = resolveModelContextProfile(modelId, providerId);
    check(
      `${providerId} ${modelId} uses the GPT-5.6 long-context Build budget`,
      profile.contextWindowTokens === 1_050_000 &&
        profile.maxOutputTokens === 128_000 &&
        profile.buildOutputReserveTokens === 128_000 &&
        profile.effectiveBuildInputCeilingTokens === 922_000 &&
        profile.longContextQuality === "excellent" &&
        profile.promptCaching === true &&
        profile.recommendedBuildRoles?.join(",") ===
          "architect,worker,reviewer,summary" &&
        profile.source === "registry",
      profile
    );
  }
}

const chatGpt55 = resolveModelContextProfile("gpt-5.5", "chatgpt");
check(
  "ChatGPT GPT-5.5 account profile uses long-context Build budget",
  chatGpt55.contextWindowTokens === 1_050_000 &&
    chatGpt55.maxOutputTokens === 128_000 &&
    chatGpt55.buildOutputReserveTokens === 128_000 &&
    chatGpt55.effectiveBuildInputCeilingTokens === 922_000 &&
    chatGpt55.source === "registry",
  chatGpt55
);

const gemini36Flash = resolveModelContextProfile("gemini-3.6-flash", "google");
check(
  "Google Gemini 3.6 Flash uses the documented long-context Build budget",
  gemini36Flash.contextWindowTokens === 1_048_576 &&
    gemini36Flash.maxOutputTokens === 65_536 &&
    gemini36Flash.buildOutputReserveTokens === 65_536 &&
    gemini36Flash.effectiveBuildInputCeilingTokens === 983_040 &&
    gemini36Flash.longContextQuality === "excellent" &&
    gemini36Flash.promptCaching === true &&
    gemini36Flash.recommendedBuildRoles?.join(",") ===
      "architect,worker,reviewer,summary" &&
    gemini36Flash.source === "registry",
  gemini36Flash
);

const gpt54Mini = resolveModelContextProfile("gpt-5.4-mini", "openai");
check(
  "OpenAI GPT-5.4 Mini profile uses current documented context and max output",
  gpt54Mini.contextWindowTokens === 400_000 &&
    gpt54Mini.maxOutputTokens === 128_000 &&
    gpt54Mini.buildOutputReserveTokens === 128_000,
  gpt54Mini
);

const chatGpt54Mini = resolveModelContextProfile("gpt-5.4-mini", "chatgpt");
check(
  "ChatGPT GPT-5.4 Mini account profile uses mini context budget",
  chatGpt54Mini.contextWindowTokens === 400_000 &&
    chatGpt54Mini.maxOutputTokens === 128_000 &&
    chatGpt54Mini.buildOutputReserveTokens === 128_000 &&
    chatGpt54Mini.source === "registry",
  chatGpt54Mini
);

const nvidiaGlm52 = resolveModelContextProfile("z-ai/glm-5.2", "nvidia");
check(
  "NVIDIA GLM-5.2 profile uses documented long-context Build budget",
  nvidiaGlm52.contextWindowTokens === 1_000_000 &&
    nvidiaGlm52.maxOutputTokens === 16_384 &&
    nvidiaGlm52.buildOutputReserveTokens === 16_384 &&
    nvidiaGlm52.effectiveBuildInputCeilingTokens === 983_616 &&
    nvidiaGlm52.longContextQuality === "excellent" &&
    nvidiaGlm52.source === "registry",
  nvidiaGlm52
);

const unknownNvidia = resolveModelContextProfile("new-nim-model", "nvidia");
check(
  "unknown NVIDIA NIM model resolves to NVIDIA provider default profile",
  unknownNvidia.contextWindowTokens === 128_000 &&
    unknownNvidia.maxOutputTokens === 16_384 &&
    unknownNvidia.buildOutputReserveTokens === 16_384 &&
    unknownNvidia.longContextQuality === "good" &&
    unknownNvidia.source === "provider-default",
  unknownNvidia
);

process.exit(failed === 0 ? 0 : 1);
