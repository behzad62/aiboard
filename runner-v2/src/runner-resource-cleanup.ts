interface ClosableRunnerResource {
  close(): void | Promise<void>;
}

export type RunnerStartupResourceClass =
  | "processes"
  | "backends"
  | "isolation"
  | "grants"
  | "spills"
  | "tempRoots";

/** `covers` declares composition completeness; successful reconciliation and subsystem ownership evidence are the cleanup proof. */
export interface RunnerStartupReconciler {
  readonly resource: string;
  readonly covers: readonly RunnerStartupResourceClass[];
  reconcile(): void | Promise<void>;
}

export interface RunnerCleanupBlocker {
  readonly resource: string;
  readonly cause: unknown;
}

export type RunnerCleanupBlockedCode =
  | "runner_startup_reconciliation_blocked"
  | "runner_shutdown_cleanup_blocked";

export class RunnerCleanupBlockedError extends AggregateError {
  readonly name = "RunnerCleanupBlockedError";

  constructor(
    readonly code: RunnerCleanupBlockedCode,
    readonly blockers: readonly RunnerCleanupBlocker[],
    message: string,
  ) {
    super(blockers.map((blocker) => blocker.cause), message);
  }
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

const REQUIRED_STARTUP_RESOURCE_CLASSES: readonly RunnerStartupResourceClass[] = Object.freeze([
  "processes",
  "backends",
  "isolation",
  "grants",
  "spills",
  "tempRoots",
]);

const RUNNER_RESOURCE_CLOSE_ORDER: readonly (keyof RunnerResources)[] = Object.freeze([
  "server",
  "builds",
  "buildFactory",
  "internalExecutionContext",
  "executionHost",
  "permissions",
  "mcpManager",
  "providerConfigs",
  "supervisor",
]);

const CLOSED_RUNNER_RESOURCES = new WeakMap<RunnerResources, Map<keyof RunnerResources, ClosableRunnerResource>>();

export async function reconcileRunnerStartup(
  reconcilers: readonly RunnerStartupReconciler[],
): Promise<void> {
  const covered = new Set<RunnerStartupResourceClass>();
  for (const reconciler of reconcilers) {
    for (const resourceClass of reconciler.covers) covered.add(resourceClass);
  }
  const missing = REQUIRED_STARTUP_RESOURCE_CLASSES.filter((resourceClass) => !covered.has(resourceClass));
  if (missing.length > 0) {
    const blockers = missing.map((resourceClass) => ({
      resource: `coverage:${resourceClass}`,
      cause: new Error(`Runner startup reconciliation does not cover ${resourceClass}.`),
    }));
    throw new RunnerCleanupBlockedError(
      "runner_startup_reconciliation_blocked",
      blockers,
      "Runner startup reconciliation coverage is incomplete.",
    );
  }

  for (const reconciler of reconcilers) {
    try {
      await reconciler.reconcile();
    } catch (error) {
      throw new RunnerCleanupBlockedError(
        "runner_startup_reconciliation_blocked",
        [{ resource: reconciler.resource, cause: error }],
        `Runner startup reconciliation is blocked by ${reconciler.resource}.`,
      );
    }
  }
}

export async function closeRunnerResources(resources?: RunnerResources): Promise<void> {
  if (!resources) return;
  let closed = CLOSED_RUNNER_RESOURCES.get(resources);
  if (!closed) {
    closed = new Map();
    CLOSED_RUNNER_RESOURCES.set(resources, closed);
  }
  const blockers: RunnerCleanupBlocker[] = [];
  for (const key of RUNNER_RESOURCE_CLOSE_ORDER) {
    const resource = resources[key];
    if (!resource || closed.get(key) === resource) continue;
    try {
      await resource.close();
      closed.set(key, resource);
    } catch (error) {
      blockers.push({ resource: key, cause: error });
    }
  }
  if (blockers.length > 0) {
    throw new RunnerCleanupBlockedError(
      "runner_shutdown_cleanup_blocked",
      blockers,
      "Runner resource cleanup is blocked by one or more owned resources.",
    );
  }
}

export function startupFailureWithCleanup(
  startupError: unknown,
  cleanupError: unknown,
): AggregateError {
  return new AggregateError(
    [startupError, cleanupError],
    `Runner startup failed (${errorSummary(startupError)}); cleanup also failed (${errorSummary(cleanupError)}).`
  );
}

function errorSummary(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
