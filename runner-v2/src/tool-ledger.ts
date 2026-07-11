import type {
  ToolCallBlock,
  ToolExecutionContext,
  ToolResult,
} from "./agent-contracts.js";

export type ToolLedgerEventType =
  | "tool.started"
  | "tool.retry_started"
  | "tool.completed";

export interface ToolLedgerEvent {
  sequence: number;
  key: string;
  type: ToolLedgerEventType;
  fingerprint: string;
  occurredAt: string;
  result?: ToolResult;
}

export interface BeginToolInvocation {
  key: string;
  fingerprint: string;
  callId: string;
  toolName: string;
  runId: string;
  sessionId: string;
  replaySafe: boolean;
  occurredAt: string;
}

export type ToolLedgerDecision =
  | { state: "new" }
  | { state: "completed"; result: ToolResult }
  | { state: "in_doubt" }
  | { state: "conflict" };

export interface ToolInvocationLedger {
  begin(input: BeginToolInvocation): ToolLedgerDecision;
  complete(
    key: string,
    fingerprint: string,
    result: ToolResult,
    occurredAt: string
  ): void;
  events(key: string): ToolLedgerEvent[];
  close(): void;
}

export function toolInvocationKey(
  context: Pick<ToolExecutionContext, "runId" | "sessionId">,
  callId: string
): string {
  return `${context.runId}\0${context.sessionId}\0${callId}`;
}

export function toolInvocationFingerprint(call: ToolCallBlock): string {
  return canonicalJson([call.name, call.arguments]);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
