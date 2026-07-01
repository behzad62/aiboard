import { createAccountRunnerProvider } from "./account-runner";
import { getCatalogModelsForProvider } from "./catalog";

export const chatgptProvider = createAccountRunnerProvider({
  id: "chatgpt",
  name: "ChatGPT Plus/Pro",
  runnerPath: "chatgpt",
  models: getCatalogModelsForProvider("chatgpt").map(
    ({ validationCandidate, ...model }) => model
  ),
});
