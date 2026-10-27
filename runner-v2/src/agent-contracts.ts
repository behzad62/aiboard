import type { OpaqueExecutionGrant } from "./execution-grants.js";
import type { FilesystemMutationPermit } from "./filesystem-mutation-fence.js";

export type AgentRole = "architect" | "worker" | "subagent" | "verifier";

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
  /**
   * Set only by Runner tools that validated a raster image for model viewing (image.inspect,
   * browser.screenshot). Adapters deliver it as native image input once, in the continuation that
   * follows the producing tool call; later turns carry only this reference.
   */
  visual?: VisualArtifactMetadata;
}

export interface VisualArtifactMetadata {
  width: number;
  height: number;
  /** Digest of the original bytes this delivered image was derived from (equal to hash when unmodified). */
  sourceDigest: string;
  transforms?: string[];
}

export interface JsonBlock {
  type: "json";
  value: unknown;
}

export type LiveOutputChannel = "text" | "reasoning" | "tool";

export interface ToolCallBlock {
  type: "tool_call";
  callId: string;
  name: string;
  arguments: unknown;
  /** Opaque provider continuation token (Gemini `thoughtSignature`) echoed back on the next request. */
  thoughtSignature?: string;
  /**
   * One per-file part of a provider-native call (a Codex `apply_patch` custom tool call), so the
   * adapter can send the original call back and merge the parts' results into its single output.
   */
  nativeCall?: { callId: string; name: string; input: string; part: number; parts: number };
}

/** The model's own reasoning for this turn, kept so it can be sent back where a provider requires it. */
export interface ReasoningBlock {
  type: "reasoning";
  text: string;
}

export type AssistantBlock = TextBlock | ToolCallBlock | ReasoningBlock;
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
    /** Dollar usage returned by the provider, kept separate from local pricing. */
    providerReportedCostUsd?: number;
  };
}

export type AgentToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; name: string };

export type AgentHostedToolType =
  | "web_search"
  | "web_fetch"
  | "shell"
  | "apply_patch"
  | "datetime"
  | "image_generation"
  | "advisor"
  | "subagent"
  | "fusion"
  | "tool_search";

export interface AgentHostedToolDefinition {
  type: AgentHostedToolType;
  parameters?: Readonly<Record<string, unknown>>;
}

export interface AgentMediaAttachment {
  filename: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "application/pdf";
  base64Data: string;
}

/** Transient, per-request image bytes for visual artifact blocks in the pending tool results. Never persisted. */
export interface ToolVisualInput {
  readonly callId: string;
  readonly hash: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly base64Data: string;
  readonly label?: string;
}

export interface AgentModelRequest {
  /** Model-native, validated images/PDFs for the newest user message. */
  attachments?: readonly AgentMediaAttachment[];
  /** Images produced by the tool calls this request answers; adapters place them in native image form. */
  toolVisuals?: readonly ToolVisualInput[];
  sessionId: string;
  messages: readonly AgentMessage[];
  tools: readonly ToolDefinition[];
  toolChoice?: AgentToolChoice;
  hostedTools?: readonly AgentHostedToolDefinition[];
  signal?: AbortSignal;
  /** Public assistant text only; do not emit reasoning or raw tool arguments. */
  /**
   * Live display only. `channel` separates model reasoning and tool-call starts from answer text
   * (default "text") so the UI can collapse reasoning; nothing here enters the turn content.
   */
  onTextDelta?: (text: string, channel?: LiveOutputChannel) => void;
}

export interface AgentModel {
  complete(request: AgentModelRequest): Promise<ModelTurn>;
  /** The model's context window, when the owner's settings know it; sizes the agent working set. */
  readonly contextWindowTokens?: number;
  /** Declared input modalities; absent means text-only for tool-delivered images. */
  readonly inputModalities?: { readonly image: boolean };
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
  /**
   * A lifecycle tool that only reads or records a read and never ends the action. It may share a
   * model turn with other calls; deciding lifecycle tools must still be alone in theirs.
   */
  batchable?: boolean;
  /**
   * Raises the broker's inline output bound for a tool whose structured result is only useful whole
   * (an over-bound result becomes a preview plus an artifact the model must page through).
   */
  inlineOutputBytes?: number;
  /** Internal tools can remain executable while being omitted from model schemas. */
  modelVisible?: boolean;
  strict?: boolean;
  /** OpenRouter Responses extension used with the hosted Tool Search tool. */
  deferLoading?: boolean;
}

export type AgentLifecycleSignal =
  | { type: "submit_task"; changeSetId: string }
  | {
      type: "verifier_verdict_submitted";
      reviewId: string;
      satisfied: boolean;
    }
  | {
      type: "verifier_expectations_recorded";
      reviewId: string;
    }
  | {
      type: "plan_critique_submitted";
      critiqueId: string;
      blockingFindingCount: number;
    }
  | { type: "ask_architect"; requestId: string; blocking: boolean }
  | { type: "request_replan"; requestId: string }
  | { type: "return_subagent"; summary: string; artifactHashes: string[] }
  | {
      type: "architect_action";
      action:
        | "plan_created"
        | "plan_reconciled"
        | "task_revised"
        | "guidance_answered"
        | "review_decided"
        | "integration_requested"
        | "acceptance_contract_upgraded"
        | "final_verification_planned"
        | "final_verification_review_decided"
        | "verification_repairs_planned"
        | "delivery_boundary_failure_resolved"
        | "test_integrity_reason_recorded"
        | "user_guidance_acknowledged"
        | "user_question_requested"
        | "plan_critique_resolved"
        | "context_recording_resolved"
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
  /** Runner-created after authorization. Model input can never populate this field. */
  executionGrant?: OpaqueExecutionGrant;
  /** Single-use last-mile ticket, backed by that same original Broker grant. */
  filesystemMutation?: FilesystemMutationPermit;
  /** Runner-set from the calling model's context window: results up to this size stay inline. */
  inlineOutputBytes?: number;
  /** Runner-set from the calling model's declared modalities. Model input can never populate this field. */
  imageInput?: boolean;
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
  network?: boolean;
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
  /**
   * Raises the broker's per-call time limit for this input. The one broker limit (120 s) cut off a
   * submit_task after its commit and capped run_evidence_command below its own timeoutMs (tunnel run).
   */
  timeoutMs?(input: TInput): number;
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
