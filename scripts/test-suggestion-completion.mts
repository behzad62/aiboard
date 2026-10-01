import assert from "node:assert/strict";
import fs from "node:fs";
import { completeSuggestedValue } from "../lib/client/suggestion-completion";
import { PROVIDER_DEFINITIONS } from "../lib/providers/provider-registry";

const base = {
  suggestion: "http://127.0.0.1:1455",
  selectionStart: 0,
  selectionEnd: 0,
  multiline: false,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
};

assert.equal(completeSuggestedValue({ ...base, key: "ArrowRight", value: "" }), "http://127.0.0.1:1455");
assert.equal(completeSuggestedValue({ ...base, key: "Tab", value: "http://127", selectionStart: 10, selectionEnd: 10 }), "http://127.0.0.1:1455");
assert.equal(completeSuggestedValue({ ...base, key: "ArrowRight", value: "http://127", selectionStart: 4, selectionEnd: 4 }), null);
assert.equal(completeSuggestedValue({ ...base, key: "Tab", value: "other", selectionStart: 5, selectionEnd: 5 }), null);
assert.equal(completeSuggestedValue({ ...base, key: "Tab", value: "", shiftKey: true }), null);
assert.equal(completeSuggestedValue({ ...base, key: "Enter", value: "" }), null);

assert.equal(
  completeSuggestedValue({
    ...base,
    key: "ArrowRight",
    value: "gpt-5.6\ngpt-",
    suggestion: "gpt-5.7",
    selectionStart: 12,
    selectionEnd: 12,
    multiline: true,
  }),
  "gpt-5.6\ngpt-5.7",
);

assert.equal(
  completeSuggestedValue({
    ...base,
    key: "Tab",
    value: "z-ai/glm-",
    suggestion: "z-ai/glm-5.2\nminimaxai/minimax-m3",
    selectionStart: 9,
    selectionEnd: 9,
    multiline: true,
  }),
  "z-ai/glm-5.2\nminimaxai/minimax-m3",
);

assert.equal(PROVIDER_DEFINITIONS.chatgpt.baseURLField?.suggestedValue, "http://127.0.0.1:1455");
assert.equal(PROVIDER_DEFINITIONS.chatgpt.modelIdsField?.suggestedValue, "gpt-5.7");
assert.equal(PROVIDER_DEFINITIONS.foundry.baseURLField?.suggestedValue, undefined);

const formSource = fs.readFileSync("components/ApiKeyForm.tsx", "utf8");
assert.match(formSource, /onKeyDown=.*acceptSuggestionFromKey/s);
assert.match(formSource, /Use suggestion/);
assert.match(formSource, /→ or Tab/);

console.log("PASS suggested input completion accepts Right Arrow/Tab/click without stealing unrelated keys or focus navigation");
