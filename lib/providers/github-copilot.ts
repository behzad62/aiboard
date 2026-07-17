import { createAccountRunnerProvider } from "./account-runner";
import { getCatalogModelsForProvider } from "./catalog";

export const githubCopilotProvider = createAccountRunnerProvider({
  id: "github-copilot",
  name: "GitHub Copilot",
  runnerPath: "github-copilot",
  // Copilot-served non-OpenAI models can ignore response_format and fence
  // their structured JSON replies; unwrap whole-reply fences app-side so
  // pre-v16 runners can't corrupt certified benchmark scoring.
  stripStructuredOutputFences: true,
  models: getCatalogModelsForProvider("github-copilot").map(
    ({ validationCandidate, ...model }) => model
  ),
});
