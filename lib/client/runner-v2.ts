export interface NativeRunnerConnection {
  url: string;
  token: string;
}

export interface NativeRunnerHealth {
  ok: true;
  protocolVersion: 2;
  projectPath: string;
  nodeVersion: string;
}

export interface NativeProviderConfig {
  runtimeId: string;
  providerId: string;
  modelId: string;
  transport: "account-runner" | "openai-compatible" | "anthropic" | "google";
  baseUrl?: string;
  secret: string;
  runnerToken?: string;
  capabilities: string[];
  priority: number;
  reasoningEffort?: string;
}

export interface CreateNativeBuildInput {
  runId: string;
  projectPath: string;
  permissionProfile: "guarded" | "project" | "full";
  idempotencyKey: string;
  build: {
    projectId: string;
    objective: string;
    architectRuntimeId: string;
    workerRuntimeIds: string[];
    maxConcurrency: number;
    budgetLimits: {
      maxModelCalls?: number;
      maxToolCalls?: number;
      maxInputTokens?: number;
      maxOutputTokens?: number;
      maxCostUsd?: number;
      maxActiveMs?: number;
    };
  };
}

export interface NativeBuildTask {
  id: string;
  objective: string;
  dependencies: string[];
  status: string;
  requiredCapabilities: string[];
  attempt: number;
  assignedWorkerId?: string;
  changeSetId?: string;
  failureReason?: string;
}

export interface NativeBuildProjection {
  runId: string;
  status: "running" | "paused" | "completed";
  planRevision: number;
  tasks: Record<string, NativeBuildTask>;
  guidance: Record<string, unknown>;
  reviews: Record<string, unknown>;
  runtime: {
    providerHealth: Record<string, unknown>;
    workerAssignments: Record<string, { runtimeId: string }>;
    architect: {
      runtimeId?: string;
      handoff?: {
        reason: string;
        requiredCapabilities: string[];
        candidateRuntimeIds: string[];
      };
    };
  };
  projectHandoff?: {
    status: "requested" | "selected";
    summary: string;
    options: NativeProjectHandoffChoice[];
    choice?: NativeProjectHandoffChoice;
    integrationRevision?: string;
    integrationBranch?: string;
    appliedToProject?: boolean;
  };
  lastSequence: number;
}

export type NativeProjectHandoffChoice =
  | "keep_integration_branch"
  | "apply_to_project";

export interface NativeBuildEvent {
  sequence: number;
  type: string;
  occurredAt: string;
  actor: { role: string; id: string };
  payload: Record<string, unknown>;
}

export interface NativeBuildStepResult {
  status: "progressed" | "paused" | "completed" | "idle";
  action?: string;
}

export interface NativeRunProjection {
  runId: string;
  state: "created" | "running" | "paused" | "stopping" | "stopped" | "completed" | "failed";
  projectPath: string;
  permissionProfile: "guarded" | "project" | "full";
  createdAt: string;
  updatedAt: string;
  lastSequence: number;
  stopReason?: string;
}

export class NativeRunnerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "NativeRunnerError";
  }
}

export async function getNativeRunnerHealth(
  connection: NativeRunnerConnection,
  fetchImpl: typeof fetch = fetch
): Promise<NativeRunnerHealth> {
  return await request(connection, "/v2/health", {}, fetchImpl);
}

export async function configureNativeProviders(
  connection: NativeRunnerConnection,
  configs: readonly NativeProviderConfig[],
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  await request(connection, "/v2/provider-configs", {
    method: "PUT",
    body: JSON.stringify({ configs }),
  }, fetchImpl);
}

export async function createNativeBuild(
  connection: NativeRunnerConnection,
  input: CreateNativeBuildInput,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  await request(connection, "/v2/runs", {
    method: "POST",
    body: JSON.stringify(input),
  }, fetchImpl);
}

export async function commandNativeRun(
  connection: NativeRunnerConnection,
  runId: string,
  command: "start" | "pause" | "resume" | "stop",
  idempotencyKey: string,
  reason?: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  await request(connection, `/v2/runs/${encodeURIComponent(runId)}/commands`, {
    method: "POST",
    body: JSON.stringify({ command, idempotencyKey, ...(reason ? { reason } : {}) }),
  }, fetchImpl);
}

export async function getNativeRun(
  connection: NativeRunnerConnection,
  runId: string,
  fetchImpl: typeof fetch = fetch
): Promise<NativeRunProjection> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}`,
    {},
    fetchImpl
  );
}

export async function getNativeBuild(
  connection: NativeRunnerConnection,
  runId: string,
  fetchImpl: typeof fetch = fetch
): Promise<NativeBuildProjection> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build`,
    {},
    fetchImpl
  );
}

export async function getNativeBuildEvents(
  connection: NativeRunnerConnection,
  runId: string,
  afterSequence = 0,
  fetchImpl: typeof fetch = fetch
): Promise<NativeBuildEvent[]> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/events?after=${afterSequence}`,
    {},
    fetchImpl
  );
}

export async function pumpNativeBuild(
  connection: NativeRunnerConnection,
  runId: string,
  maxSteps = 100,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<NativeBuildStepResult> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/run`,
    {
      method: "POST",
      body: JSON.stringify({ maxSteps }),
      signal,
    },
    fetchImpl
  );
}

export async function stepNativeBuild(
  connection: NativeRunnerConnection,
  runId: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<NativeBuildStepResult> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/step`,
    { method: "POST", body: "{}", signal },
    fetchImpl
  );
}

export async function selectNativeArchitectHandoff(
  connection: NativeRunnerConnection,
  runId: string,
  runtimeId: string,
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<NativeBuildProjection> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/architect-handoff`,
    {
      method: "POST",
      body: JSON.stringify({ runtimeId, idempotencyKey }),
    },
    fetchImpl
  );
}

export async function selectNativeProjectHandoff(
  connection: NativeRunnerConnection,
  runId: string,
  choice: NativeProjectHandoffChoice,
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<NativeBuildProjection> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/project-handoff`,
    {
      method: "POST",
      body: JSON.stringify({ choice, idempotencyKey }),
    },
    fetchImpl
  );
}

async function request<T>(
  connection: NativeRunnerConnection,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<T> {
  const response = await fetchImpl(`${connection.url.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const data = await response.json().catch(() => ({})) as {
    error?: string;
    code?: string;
  } & T;
  if (!response.ok) {
    throw new NativeRunnerError(
      data.error ?? `Native runner request failed (HTTP ${response.status}).`,
      response.status,
      data.code
    );
  }
  return data;
}
