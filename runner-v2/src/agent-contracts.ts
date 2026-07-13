export type AgentRole = "architect" | "worker" | "subagent";

export interface AgentActor {
  role: AgentRole;
  id: string;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ArtifactBlock {
  type: "artifact";
  hash: string;
  mediaType: string;
  label?: string;
}

export interface JsonBlock {
  type: "json";
  value: unknown;
}

export interface ToolCallBlock {
  type: "tool_call";
  callId: string;
  name: string;
  arguments: unknown;
}

export type AssistantBlock = TextBlock | ToolCallBlock;
export type ToolContentBlock = TextBlock | ArtifactBlock | JsonBlock;

export interface AgentMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string | AssistantBlock[] | ToolResult;
}

export type ModelStopReason =
  | "tool_calls"
  | "end_turn"
  | "max_tokens"
  | "cancelled";

export interface ModelTurn {
  blocks: AssistantBlock[];
  stopReason: ModelStopReason;
  providerRequestId?: string;
  usage?: {
    inputTokens?: number;
    inputTokenSource?: "reported" | "estimated";
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    outputTokens?: number;
  };
}

export interface AgentModelRequest {
  sessionId: string;
  messages: readonly AgentMessage[];
  tools: readonly ToolDefinition[];
  signal?: AbortSignal;
}

export interface AgentModel {
  complete(request: AgentModelRequest): Promise<ModelTurn>;
}

export type JsonSchema = Readonly<Record<string, unknown>>;
export type ToolEffect = "none" | "workspace" | "external";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  readOnly: boolean;
  effect: ToolEffect;
  lifecycle?: boolean;
}

export type AgentLifecycleSignal =
  | { type: "submit_task"; changeSetId: string }
  | { type: "ask_architect"; requestId: string; blocking: boolean }
  | { type: "request_replan"; requestId: string }
  | { type: "return_subagent"; summary: string; artifactHashes: string[] }
  | {
      type: "architect_action";
      action:
        | "plan_created"
        | "task_revised"
        | "guidance_answered"
        | "review_decided"
        | "integration_requested"
        | "run_completed";
      referenceId?: string;
    };

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: string[] };

export interface ToolExecutionContext {
  runId: string;
  sessionId: string;
  actor: AgentActor;
  workspacePath?: string;
  signal?: AbortSignal;
  callId?: string;
  toolName?: string;
}

export type ToolPathAccessMode = "read" | "write" | "delete";

export interface ToolPathAccess {
  path: string;
  access: ToolPathAccessMode;
}

export interface ToolAccessRequest {
  capability: string;
  paths?: ToolPathAccess[];
  external?: boolean;
  destructive?: boolean;
  credentialChange?: boolean;
}

export interface ToolExecutionOutput {
  content: ToolContentBlock[];
  isError: boolean;
  error?: ToolError;
  lifecycle?: AgentLifecycleSignal;
}

export interface NativeTool<TInput = unknown> {
  definition: ToolDefinition;
  validate(input: unknown): ValidationResult<TInput>;
  assessAccess?(
    input: TInput,
    context: ToolExecutionContext
  ): ToolAccessRequest;
  execute(
    input: TInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionOutput>;
}

export interface ToolError {
  code: string;
  message: string;
  issues?: string[];
}

export interface ToolResult extends ToolExecutionOutput {
  callId: string;
  toolName: string;
}
