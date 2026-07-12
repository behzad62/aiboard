export const DEFAULT_RUNNER_V2_URL = "http://127.0.0.1:8787";

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
  inputCapabilities?: {
    image: boolean;
    document: boolean;
    audio: boolean;
    video: boolean;
  };
  priority: number;
  reasoningEffort?: string;
  protocol?: "chat-completions" | "responses";
  inputCostMicrosPerMillion?: number;
  outputCostMicrosPerMillion?: number;
  cachedInputCostMicrosPerMillion?: number;
  cacheWriteInputCostMicrosPerMillion?: number;
}

export interface NativePermissionRequest {
  requestId: string;
  runId: string;
  sessionId: string;
  callId: string;
  toolName: string;
  actor: { role: "architect" | "worker" | "subagent"; id: string };
  permissionProfile: "guarded" | "project" | "full";
  access: { capability: string; external?: boolean; destructive?: boolean; credentialChange?: boolean };
  outsideWorkspace: boolean;
  status: "pending" | "approved" | "denied";
  occurredAt: string;
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
  integrationRevision?: string;
  conflictPaths?: string[];
}

export interface NativeGuidanceProjection {
  requestId: string;
  taskId: string;
  blocking: boolean;
  question: string;
  evidenceSequence: number;
  version: number;
  status: "open" | "answered";
  answer?: string;
  challengeEvidenceSequence?: number;
  challengedVersion?: number;
  challengeReason?: string;
}

export interface NativeReviewProjection {
  taskId: string;
  status: "requested" | "approved" | "rejected";
  summary?: string;
  evidenceArtifactHashes: string[];
}

export interface NativeBuildProjection {
  runId: string;
  status: "running" | "paused" | "completed";
  planRevision: number;
  tasks: Record<string, NativeBuildTask>;
  guidance: Record<string, NativeGuidanceProjection>;
  reviews: Record<string, NativeReviewProjection>;
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

export interface NativeBuildUsageProjection {
  scopeId: string;
  reservations: Record<string, unknown>;
  activeSegments: Record<string, unknown>;
  effective: {
    modelCalls: number;
    toolCalls: number;
    inputTokens: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    outputTokens: number;
    estimatedCostMicros: number;
    activeMs: number;
    artifactBytes: number;
  };
  lastSequence: number;
}

export interface NativeBuildObservability {
  runId: string;
  budget: NativeBuildUsageProjection;
  toolCallCount: number;
  agents: Array<{
    sessionId: string;
    actor: { role: "architect" | "worker" | "subagent"; id: string };
    status: "active" | "suspended" | "submitted" | "completed";
    turns: number;
    suspensionReason?: string;
    error?: string;
    changeSetId?: string;
    lastSequence: number;
  }>;
  tools: Array<{
    sequence: number;
    sessionId: string;
    callId: string;
    toolName: string;
    status: "started" | "retrying" | "completed";
    occurredAt: string;
    isError?: boolean;
    errorCode?: string;
  }>;
  evidence: Array<{
    id: string;
    taskId: string;
    actor: { role: "architect" | "worker" | "subagent"; id: string };
    status: "observed";
    fact: { kind: "command"; label: string; command: string; exitCode: number | null };
    createdAt: string;
  }>;
  memories: Array<{
    id: string;
    content: string;
    concepts: string[];
    status: "proposed" | "promoted" | "archived";
    updatedAt: string;
  }>;
  skills: Array<{
    id: string;
    name: string;
    description: string;
    source: "project" | "built-in" | "user";
    digest: string;
  }>;
  processes: Array<{
    processId: string;
    sessionId: string;
    command: string;
    args: string[];
    status: "running" | "stopped" | "exited_unknown";
    startedAt: string;
    updatedAt: string;
    exitCode: number | null;
  }>;
  providers: Array<{
    providerId: string;
    status: "healthy" | "cooldown";
    consecutiveFailures: number;
    updatedAt: number;
    failureKind?: string;
    failureMessage?: string;
    cooldownUntil?: number;
  }>;
  events: Array<{
    sequence: number;
    type: string;
    occurredAt: string;
    actor: { role: string; id: string };
    payload: Record<string, unknown>;
  }>;
  git: {
    integrationBranch: string;
    integrationRevision: string;
    commits: Array<{ revision: string; parents: string[]; subject: string }>;
  };
}

export interface NativeBuildAuditExport {
  protocolVersion: 2;
  run: NativeRunProjection;
  build: NativeBuildProjection;
  usage: NativeBuildUsageProjection;
  observability: NativeBuildObservability;
  runEvents: Array<Record<string, unknown>>;
  buildEvents: NativeBuildEvent[];
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

export async function getNativeBuildUsage(
  connection: NativeRunnerConnection,
  runId: string,
  fetchImpl: typeof fetch = fetch
): Promise<NativeBuildUsageProjection> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/usage`,
    {},
    fetchImpl
  );
}

export async function getNativeBuildObservability(
  connection: NativeRunnerConnection,
  runId: string,
  fetchImpl: typeof fetch = fetch
): Promise<NativeBuildObservability> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/observability`,
    {},
    fetchImpl
  );
}

export async function getNativeBuildAudit(
  connection: NativeRunnerConnection,
  runId: string,
  fetchImpl: typeof fetch = fetch
): Promise<NativeBuildAuditExport> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/audit`,
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

export async function getNativePermissions(
  connection: NativeRunnerConnection,
  runId: string,
  fetchImpl: typeof fetch = fetch
): Promise<NativePermissionRequest[]> {
  const result = await request<{ permissions: NativePermissionRequest[] }>(
    connection,
    `/v2/permissions?runId=${encodeURIComponent(runId)}`,
    {},
    fetchImpl
  );
  return result.permissions;
}

export async function decideNativePermission(
  connection: NativeRunnerConnection,
  requestId: string,
  decision: "approved" | "denied",
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<NativePermissionRequest> {
  return await request(
    connection,
    `/v2/permissions/${encodeURIComponent(requestId)}`,
    {
      method: "POST",
      body: JSON.stringify({ decision, idempotencyKey }),
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
