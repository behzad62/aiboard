import assert from "node:assert/strict";
import { listCopilotSdkModels } from "../lib/account-provider-copilot-sdk.mjs";

let capturedOptions: Record<string, unknown> | undefined;
let started = false;
let stopped = false;
let listed = false;
const expected = [
  {
    id: "gpt-test",
    name: "GPT Test",
    capabilities: { supports: { vision: true, reasoningEffort: true } },
  },
];

const result = await listCopilotSdkModels(
  "github-token",
  "C:\\aiboard-copilot-test",
  {
    clientFactory: (options: Record<string, unknown>) => {
      capturedOptions = options;
      return {
        async start() { started = true; },
        async stop() { stopped = true; },
        async listModels() { listed = true; return expected; },
      };
    },
  }
);

assert.equal(started, true);
assert.equal(listed, true);
assert.equal(stopped, true);
assert.equal(capturedOptions?.gitHubToken, "github-token");
assert.equal(capturedOptions?.useLoggedInUser, false);
assert.equal(capturedOptions?.mode, "empty");
assert.deepEqual(result, expected);
console.log("PASS GitHub Copilot model discovery uses the authenticated SDK catalog and closes the client");
