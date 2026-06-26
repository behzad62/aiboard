import type { ModelInfo } from "./base";
import {
  ACCOUNT_RUNNER_TEXT_AND_IMAGE_ATTACHMENTS,
  createAccountRunnerProvider,
} from "./account-runner";

const GITHUB_COPILOT_MODELS: ModelInfo[] = [
  {
    id: "auto",
    name: "Copilot Auto",
    providerId: "github-copilot",
    description: "Let GitHub Copilot choose the best account-backed model",
    capabilities: { ...ACCOUNT_RUNNER_TEXT_AND_IMAGE_ATTACHMENTS },
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4 (Copilot)",
    providerId: "github-copilot",
    description: "GitHub Copilot account model through the local account-provider runner",
    capabilities: { ...ACCOUNT_RUNNER_TEXT_AND_IMAGE_ATTACHMENTS },
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini (Copilot)",
    providerId: "github-copilot",
    description: "Fast GitHub Copilot account model through the local account-provider runner",
    capabilities: { ...ACCOUNT_RUNNER_TEXT_AND_IMAGE_ATTACHMENTS },
  },
  {
    id: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5 (Copilot)",
    providerId: "github-copilot",
    description: "Claude model exposed through GitHub Copilot when available on the account",
    capabilities: { ...ACCOUNT_RUNNER_TEXT_AND_IMAGE_ATTACHMENTS },
  },
];

export const githubCopilotProvider = createAccountRunnerProvider({
  id: "github-copilot",
  name: "GitHub Copilot",
  runnerPath: "github-copilot",
  models: GITHUB_COPILOT_MODELS,
});
