import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderCapabilityTable } from "../components/ProviderCapabilityTable";
import { resolveProviderCapabilityProfile } from "../lib/providers/capability-resolution";
import type { ToolReadinessStatus } from "../lib/providers/tool-capabilities";
import {
  capabilityStatusRows,
  capabilityStatusView,
  type ProviderCapabilityStatusLabel,
} from "../lib/providers/capability-status";

const expected = new Map<string, ProviderCapabilityStatusLabel>([
  ["available", "Available now"],
  ["setup_required", "Supported — setup required"],
  ["conditional", "Conditional / not yet verified"],
  ["unknown", "Conditional / not yet verified"],
  ["unsupported", "Unsupported"],
]);
for (const [readiness, label] of expected) {
  assert.equal(capabilityStatusView({ readiness: readiness as ToolReadinessStatus }).label, label);
}
console.log("PASS exactly four user-facing capability states map from readiness");

const openai = resolveProviderCapabilityProfile({
  providerId: "openai",
  modelId: "gpt-5.6-sol",
  resourceState: { prerequisites: {} },
});
const fileSearch = capabilityStatusRows(openai).find((row) => row.capabilityId === "file_search");
assert.equal(fileSearch?.statusLabel, "Supported — setup required");
assert.deepEqual(fileSearch?.missingPrerequisites, [
  {
    id: "openai_vector_store",
    label: "OpenAI vector store",
    kind: "resource",
    configurationPath: "providers.openai.vectorStoreIds",
  },
]);
console.log("PASS setup-required rows expose real missing prerequisites and configuration paths");

const copilot = resolveProviderCapabilityProfile({
  providerId: "github-copilot",
  modelId: "some-discovered-model",
});
assert.equal(
  capabilityStatusRows(copilot).find((row) => row.capabilityId === "function_calling")?.statusLabel,
  "Conditional / not yet verified",
);
console.log("PASS account-provider capability stays unverified without current runner evidence");

const custom = resolveProviderCapabilityProfile({
  providerId: "custom",
  modelId: "local-model",
  customOverrides: [
    {
      id: "function_calling",
      support: "supported",
      execution: "client",
      transports: ["chat_completions"],
      supportSource: "user-override",
    },
  ],
});
assert.equal(
  capabilityStatusRows(custom).find((row) => row.capabilityId === "function_calling")?.statusLabel,
  "Available now",
);
console.log("PASS explicit custom override is presented as available when ready");
const customResponsesOnly = resolveProviderCapabilityProfile({
  providerId: "custom",
  modelId: "chat-only-endpoint",
  customOverrides: [
    {
      id: "web_search",
      support: "supported",
      execution: "provider",
      transports: ["responses"],
      supportSource: "user-override",
    },
  ],
});
const transportMismatch = capabilityStatusRows(customResponsesOnly, {
  allowedTransports: ["chat_completions"],
}).find((row) => row.capabilityId === "web_search");
assert.equal(transportMismatch?.statusLabel, "Supported — setup required");
assert.match(transportMismatch?.detail ?? "", /compatible transport/i);
console.log("PASS resolved status accounts for currently allowed runtime transports");

const discoveredOpenRouter = resolveProviderCapabilityProfile({
  providerId: "openrouter",
  modelId: "vendor/newly-discovered-model",
});
assert.equal(
  capabilityStatusRows(discoveredOpenRouter).find((row) => row.capabilityId === "function_calling")?.statusLabel,
  "Conditional / not yet verified",
  "model discovery alone must not imply tool support",
);
console.log("PASS model discovery remains separate from verified tool support");
const rendered = renderToStaticMarkup(
  React.createElement(ProviderCapabilityTable, {
    rows: capabilityStatusRows(openai),
  }),
);
assert.match(rendered, /Tool support &amp; readiness/);
assert.match(rendered, /Model discovery alone does not verify tool support/);
assert.match(rendered, /Supported — setup required/);
assert.match(rendered, /Missing: OpenAI vector store/);
assert.doesNotMatch(rendered, /configuration: providers\.openai\.vectorStoreIds/);
assert.match(rendered, /Configure tools/);
assert.match(rendered, /Missing: OpenAI vector store<\/p>/, "resources without a real setup surface stay text-only");
console.log("PASS rendered capability table keeps discovery, evidence, and actionable setup guidance distinct");

console.log("PASS");
