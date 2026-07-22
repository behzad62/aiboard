/* GPT-5.6 legacy model-id migration checks (run: npx tsx scripts/test-model-id-migration.mts) */
import assert from "node:assert/strict";
import {
  migrateFullModelId,
  migrateModelIdKeyedRecord,
  migrateProviderModelId,
} from "../lib/providers/model-id-migration";

assert.equal(migrateProviderModelId("openai", "gpt-5.6"), "gpt-5.6-terra");
assert.equal(migrateProviderModelId("openai", "gpt-5.6-pro"), "gpt-5.6-sol");
assert.equal(migrateProviderModelId("openai", "gpt-5.6-mini"), "gpt-5.6-luna");
assert.equal(migrateFullModelId("openai:gpt-5.6-pro"), "openai:gpt-5.6-sol");
assert.equal(migrateFullModelId("chatgpt:gpt-5.6"), "chatgpt:gpt-5.6");
assert.equal(migrateFullModelId("openai:gpt-5.6-sol"), "openai:gpt-5.6-sol");
assert.equal(migrateFullModelId("openai:unknown"), "openai:unknown");
assert.equal(migrateFullModelId("malformed"), "malformed");
assert.equal(
  migrateFullModelId(migrateFullModelId("openai:gpt-5.6")),
  "openai:gpt-5.6-terra"
);

const migrated = migrateModelIdKeyedRecord({
  "openai:gpt-5.6": "legacy",
  "openai:gpt-5.6-terra": "current",
  "anthropic:gpt-5.6": "other",
});
assert.deepEqual(migrated, {
  "openai:gpt-5.6-terra": "current",
  "anthropic:gpt-5.6": "other",
});

assert.equal(migrateModelIdKeyedRecord(undefined), undefined);
console.log("PASS");
