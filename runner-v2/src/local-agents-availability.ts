export class LocalAgentsUnavailableError extends Error {
  readonly code = "local_agents_unavailable_nested_state";
  readonly status = 409;

  constructor() {
    super("Started from a folder that contains AIBoard's own state; start aiboard from a project folder to use Build/Chat.");
    this.name = "LocalAgentsUnavailableError";
  }
}

export function assertLocalAgentsAvailable(unavailable: boolean | undefined): void {
  if (unavailable) throw new LocalAgentsUnavailableError();
}
