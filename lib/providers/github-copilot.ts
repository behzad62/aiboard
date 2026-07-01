import { createAccountRunnerProvider } from "./account-runner";
import { getCatalogModelsForProvider } from "./catalog";

export const githubCopilotProvider = createAccountRunnerProvider({
  id: "github-copilot",
  name: "GitHub Copilot",
  runnerPath: "github-copilot",
  models: getCatalogModelsForProvider("github-copilot").map(
    ({ validationCandidate, ...model }) => model
  ),
});
