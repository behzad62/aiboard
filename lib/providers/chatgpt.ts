import type { ModelInfo } from "./base";
import {
  ACCOUNT_RUNNER_TEXT_AND_IMAGE_ATTACHMENTS,
  createAccountRunnerProvider,
} from "./account-runner";

const CHATGPT_MODELS: ModelInfo[] = [
  {
    id: "gpt-5.5",
    name: "GPT-5.5 (ChatGPT)",
    providerId: "chatgpt",
    description: "ChatGPT Plus/Pro account model through the local account-provider runner",
    capabilities: { ...ACCOUNT_RUNNER_TEXT_AND_IMAGE_ATTACHMENTS },
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4 (ChatGPT)",
    providerId: "chatgpt",
    description: "ChatGPT account model through the local account-provider runner",
    capabilities: { ...ACCOUNT_RUNNER_TEXT_AND_IMAGE_ATTACHMENTS },
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini (ChatGPT)",
    providerId: "chatgpt",
    description: "Fast ChatGPT account model through the local account-provider runner",
    capabilities: { ...ACCOUNT_RUNNER_TEXT_AND_IMAGE_ATTACHMENTS },
  },
  {
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark (ChatGPT)",
    providerId: "chatgpt",
    description: "Codex-style ChatGPT account model through the local account-provider runner",
    capabilities: { ...ACCOUNT_RUNNER_TEXT_AND_IMAGE_ATTACHMENTS },
  },
];

export const chatgptProvider = createAccountRunnerProvider({
  id: "chatgpt",
  name: "ChatGPT Plus/Pro",
  runnerPath: "chatgpt",
  models: CHATGPT_MODELS,
});
