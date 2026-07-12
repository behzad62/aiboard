import type {
  AgentMessage,
  NativeTool,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import type { SqliteAgentSessionStore } from "./sqlite-agent-session-store.js";

export function createSessionTools(
  sessions: SqliteAgentSessionStore
): NativeTool<SessionHistorySearch>[] {
  return [{
    definition: {
      name: "search_session_history",
      description:
        "Search this agent's own durable raw message and tool-result history after working-context compaction",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 1_000 },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      readOnly: true,
      effect: "none",
    },
    validate: validateSearch,
    execute: async (input, context) => {
      try {
        const session = await sessions.load(context.sessionId);
        if (session.runId !== context.runId || session.actor.role !== context.actor.role) {
          return failure("session_identity_mismatch", "Session identity does not match the current agent context.");
        }
        const query = input.query.toLowerCase();
        const matches = (session.checkpoint?.messages ?? [])
          .map(projectMessage)
          .filter((message) => JSON.stringify(message.content).toLowerCase().includes(query))
          .slice(-input.limit);
        return { content: [{ type: "json", value: matches }], isError: false };
      } catch (error) {
        return failure(
          "session_history_unavailable",
          error instanceof Error ? error.message : String(error)
        );
      }
    },
  }];
}

interface SessionHistorySearch {
  query: string;
  limit: number;
}

function validateSearch(input: unknown): ValidationResult<SessionHistorySearch> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, issues: ["arguments must be an object"] };
  }
  const value = input as Record<string, unknown>;
  const limit = value.limit ?? 20;
  if (
    typeof value.query !== "string" ||
    !value.query.trim() ||
    value.query.length > 1_000 ||
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > 50
  ) {
    return { ok: false, issues: ["query and a limit from 1 to 50 are required"] };
  }
  return { ok: true, value: { query: value.query.trim(), limit: limit as number } };
}

function projectMessage(message: AgentMessage): { id: string; role: AgentMessage["role"]; content: unknown } {
  return {
    id: message.id,
    role: message.role,
    content: boundedContent(message.content),
  };
}

function boundedContent(content: AgentMessage["content"]): unknown {
  const serialized = typeof content === "string" ? content : JSON.stringify(content);
  if (Buffer.byteLength(serialized) <= 8 * 1024) return content;
  return `${serialized.slice(0, 8 * 1024)}\n[history result truncated]`;
}

function failure(code: string, message: string): ToolExecutionOutput {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message },
  };
}
