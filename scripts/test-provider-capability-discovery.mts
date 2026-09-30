import assert from "node:assert/strict";
import type { UserSettings } from "../lib/db/schema";

import { migrateProviderCapabilitySettings } from "../lib/client/provider-capability-migration";
import {
  capabilityEvidenceFromToolProbe,
  type CapabilityProbeResult,
} from "../lib/providers/capability-probes";

const legacySettings: UserSettings = {
  id: "default",
  defaultEffort: "medium",
  defaultMode: "panel",
  judgeModelId: null,
  discoveredModelCapabilities: {
    "openrouter:vendor/tool-model": {
      image: true,
      document: false,
      audio: false,
      video: false,
      tools: true,
      toolChoice: true,
      structuredOutputs: true,
      reasoning: true,
      reasoningEffort: false,
      temperature: true,
      maxTokens: true,
      updatedAt: "2026-09-29T10:00:00.000Z",
      source: "openrouter-models",
    },
    "google:gemini-discovered": {
      image: true,
      document: true,
      audio: false,
      video: false,
      tools: true,
      toolChoice: true,
      structuredOutputs: true,
      reasoning: true,
      reasoningEffort: true,
      temperature: true,
      maxTokens: true,
      updatedAt: "2026-09-29T11:00:00.000Z",
      source: "provider-models",
    },
  },
};

const migrated = migrateProviderCapabilitySettings(legacySettings);
assert.equal(migrated.changed, true);
assert.equal(migrated.settings.discoveredModelCapabilities, undefined);
assert.deepEqual(migrated.settings.discoveredModelMetadata?.["openrouter:vendor/tool-model"], {
  image: true,
  document: false,
  audio: false,
  video: false,
  apiParameters: {
    toolChoice: true,
    structuredOutputs: true,
    reasoning: true,
    reasoningEffort: false,
    temperature: true,
    maxTokens: true,
  },
  updatedAt: "2026-09-29T10:00:00.000Z",
  source: "openrouter-models",
});
assert.equal(
  migrated.settings.discoveredModelMetadata?.["google:gemini-discovered"]?.image,
  true,
);
assert.deepEqual(
  migrated.settings.providerToolCapabilityEvidence,
  [
    {
      providerId: "openrouter",
      modelId: "vendor/tool-model",
      capabilityId: "function_calling",
      transport: "responses",
      support: "supported",
      execution: "client",
      source: "provider-catalog",
      verifiedAt: "2026-09-29T10:00:00.000Z",
      detail: "Migrated from OpenRouter supported_parameters.tools catalog metadata.",
    },
  ],
  "generic provider model listings must never become verified tool evidence",
);
const second = migrateProviderCapabilitySettings(migrated.settings);
assert.equal(second.changed, false, "capability persistence migration must be idempotent");
assert.equal(second.settings, migrated.settings);
console.log("PASS legacy discovery metadata migrates without generic tool guesses");

const testedAt = "2026-09-30T00:00:00.000Z";
const expiresAt = "2026-10-07T00:00:00.000Z";
const pass: CapabilityProbeResult = {
  id: "toolCalls",
  status: "pass",
  detail: "Provider emitted the requested function call",
};
assert.deepEqual(
  capabilityEvidenceFromToolProbe({
    providerId: "xai",
    modelId: "grok-test",
    transport: "responses",
    testedAt,
    expiresAt,
    result: pass,
  }),
  {
    providerId: "xai",
    modelId: "grok-test",
    capabilityId: "function_calling",
    transport: "responses",
    support: "supported",
    execution: "client",
    source: "probed",
    verifiedAt: testedAt,
    expiresAt,
    detail: "Provider emitted the requested function call",
  },
);
console.log("PASS positive real tool probe produces scoped expiring evidence");

const protocolUnsupported: CapabilityProbeResult = {
  id: "toolCalls",
  status: "fail",
  detail: "400 unsupported_parameter: tools are not supported for this model",
  failureKind: "protocol_unsupported",
  errorMetadata: { statusCode: 400, code: "unsupported_parameter" },
};
assert.equal(
  capabilityEvidenceFromToolProbe({
    providerId: "openrouter",
    modelId: "vendor/no-tools",
    transport: "responses",
    testedAt,
    expiresAt,
    result: protocolUnsupported,
  })?.support,
  "unsupported",
);
console.log("PASS genuine protocol-level tool rejection can produce unsupported evidence");

for (const transient of [
  {
    id: "toolCalls",
    status: "fail",
    detail: "401 invalid API key",
    failureKind: "transient" as const,
    errorMetadata: { statusCode: 401 },
  },
  {
    id: "toolCalls",
    status: "fail",
    detail: "fetch failed: ECONNRESET",
    failureKind: "transient" as const,
  },
  {
    id: "toolCalls",
    status: "fail",
    detail: "429 rate limit",
    failureKind: "transient" as const,
    errorMetadata: { statusCode: 429 },
  },
] satisfies CapabilityProbeResult[]) {
  assert.equal(
    capabilityEvidenceFromToolProbe({
      providerId: "google",
      modelId: "gemini-test",
      transport: "gemini_interactions",
      testedAt,
      expiresAt,
      result: transient,
    }),
    undefined,
  );
}
console.log("PASS transient auth/network/rate-limit probe failures never become unsupported evidence");

console.log("PASS");
