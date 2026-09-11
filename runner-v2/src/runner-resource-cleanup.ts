interface ClosableRunnerResource {
  close(): void | Promise<void>;
}

export interface RunnerResources {
  server?: ClosableRunnerResource;
  builds?: ClosableRunnerResource;
  buildFactory?: ClosableRunnerResource;
  internalExecutionContext?: ClosableRunnerResource;
  executionHost?: ClosableRunnerResource;
  permissions?: ClosableRunnerResource;
  mcpManager?: ClosableRunnerResource;
  providerConfigs?: ClosableRunnerResource;
  supervisor?: ClosableRunnerResource;
}

/** Closes only resources acquired during startup, in reverse dependency order. */
export async function closeRunnerResources(resources?: RunnerResources): Promise<void> {
  if (!resources) return;
  const failures: unknown[] = [];
  await closeResource(resources.server, failures);
  await closeResource(resources.builds, failures);
  await closeResource(resources.buildFactory, failures);
  await closeResource(resources.internalExecutionContext, failures);
  await closeResource(resources.executionHost, failures);
  await closeResource(resources.permissions, failures);
  await closeResource(resources.mcpManager, failures);
  await closeResource(resources.providerConfigs, failures);
  await closeResource(resources.supervisor, failures);
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "One or more Runner startup resources failed to close.",
    );
  }
}

export function startupFailureWithCleanup(
  startupError: unknown,
  cleanupError: unknown,
): AggregateError {
  return new AggregateError(
    [startupError, cleanupError],
    `Runner startup failed: ${errorMessage(startupError)}. Cleanup also failed: ${errorMessage(cleanupError)}.`,
  );
}

async function closeResource(
  resource: ClosableRunnerResource | undefined,
  failures: unknown[],
): Promise<void> {
  if (!resource) return;
  try {
    await resource.close();
  } catch (error) {
    failures.push(error);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
