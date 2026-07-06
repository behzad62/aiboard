import { createAccountRunnerProvider } from "./account-runner";

export const nvidiaProvider = createAccountRunnerProvider({
  id: "nvidia",
  name: "NVIDIA NIM",
  runnerPath: "nvidia",
  models: [],
  credentialMode: "provider-api-key-with-runner-token",
});
