import { setTimeout as delay } from "node:timers/promises";
import { CreateTaskResultV2Schema, GetTaskResultV2Schema, InputRequiredCallToolResultV2Schema, ElicitResultV2Schema, UpdateTaskResultV2Schema, CancelTaskResultV2Schema } from "@modelcontextprotocol/ext-tasks/core/v2";

export const MCP_TASK_CAPABILITIES = Object.freeze({ extensions: { "io.modelcontextprotocol/tasks": {} } });
type Rpc = (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
export type McpInputResolver = (request: Readonly<Record<string, unknown>>, signal: AbortSignal, source?: string) => Promise<unknown>;
export class McpOptionalFeatureError extends Error {
  constructor(message: string) { super(message); this.name = "McpOptionalFeatureError"; }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

async function resolveBounded(resolve: McpInputResolver, request: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error("MCP input expired."));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => resolve(request, signal)), cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Only explicit protocol continuation is permitted; never replay a lost initial call.
 * Input is never synthesized by a model. No resolver means decline, not consent.
 */
export async function settleModernToolCall(options: {
  initial: unknown;
  params: Record<string, unknown>;
  request: Rpc;
  timeoutMs: number;
  signal?: AbortSignal;
  resolveInput?: McpInputResolver;
  onTask?: (task: import("./mcp-task-recovery.js").McpTaskHandleObservation) => void;
}): Promise<Record<string, unknown>> {
  const deadline = AbortSignal.timeout(Math.max(1, options.timeoutMs));
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const check = () => signal.throwIfAborted();
  const input = async (requests: Record<string, unknown>) => {
    const entries = Object.entries(requests);
    if (entries.length > 16) throw new McpOptionalFeatureError("MCP requested too many input exchanges.");
    const answers = Object.create(null) as Record<string, unknown>;
    for (const [key, request] of entries) {
      check();
      if (!key || key.length > 256 || !object(request) || request.method !== "elicitation/create")
        throw new McpOptionalFeatureError("MCP input method is not authorized; sampling and roots are not supported.");
      if (!object(request.params)) throw new McpOptionalFeatureError("MCP elicitation parameters are invalid.");
      const answer = options.resolveInput ? await resolveBounded(options.resolveInput, request, signal) : { action: "decline" };
      check();
      const parsed = ElicitResultV2Schema.safeParse(answer);
      if (!parsed.success) throw new McpOptionalFeatureError("MCP elicitation answer is invalid.");
      answers[key] = parsed.data;
    }
    return answers;
  };
  let result = options.initial;
  let taskId: string | undefined;
  try {
    for (let round = 0; round < 8; round++) {
      check();
      if (!object(result)) throw new McpOptionalFeatureError("Invalid MCP tool result.");
      if (result.resultType !== "input_required") break;
      const parsed = InputRequiredCallToolResultV2Schema.safeParse(result);
      if (!parsed.success || !parsed.data.inputRequests || Object.keys(parsed.data.inputRequests).length === 0)
        throw new McpOptionalFeatureError("Invalid MCP continuation.");
      if (typeof parsed.data.requestState === "string" && parsed.data.requestState.length > 65536)
        throw new McpOptionalFeatureError("MCP continuation state exceeds its bound.");
      const inputResponses = await input(parsed.data.inputRequests);
      check();
      result = await options.request("tools/call", { ...options.params, inputResponses,
        ...(parsed.data.requestState === undefined ? {} : { requestState: parsed.data.requestState }) }, signal);
    }
    if (!object(result)) throw new McpOptionalFeatureError("Invalid MCP tool result.");
    if (result.resultType === "input_required") throw new McpOptionalFeatureError("MCP continuation round limit exceeded.");
    if (result.resultType !== "task") {
      if (!Array.isArray(result.content)) throw new McpOptionalFeatureError("MCP did not return completed tool content.");
      return result;
    }
    const created = CreateTaskResultV2Schema.safeParse(result);
    if (!created.success || !created.data.taskId || created.data.taskId.length > 512)
      throw new McpOptionalFeatureError("Invalid MCP task handle.");
    const taskCreatedAt=Date.parse(created.data.createdAt);
    if (!Number.isFinite(taskCreatedAt)) throw new McpOptionalFeatureError("Invalid MCP task creation time.");
    taskId = created.data.taskId;
    const now = Date.now();
    const ttl = created.data.ttlMs;
    const expiresAt = Math.min(now + 24*60*60_000,
      typeof ttl === "number" ? taskCreatedAt + ttl : Infinity);
    if (Number.isSafeInteger(expiresAt) && expiresAt > now) options.onTask?.({taskId,createdAt:created.data.createdAt,expiresAt});
    let interval = created.data.pollIntervalMs ?? 1000;
    let updates = 0;
    for (let poll = 0; poll < 240; poll++) {
      check();
      await delay(Math.max(100, Math.min(2_147_483_647, interval)), undefined, { signal });
      const raw = await options.request("tasks/get", { taskId }, signal);
      const parsed = GetTaskResultV2Schema.safeParse(raw);
      if (!parsed.success || parsed.data.taskId !== taskId) throw new McpOptionalFeatureError("MCP task status did not match its handle.");
      const task = parsed.data;
      if (Date.parse(task.createdAt)!==taskCreatedAt) {
        // Same ID with a different incarnation is not our task. Even a
        // cancellation could affect an unrelated operation.
        taskId=undefined;
        throw new McpOptionalFeatureError("MCP task creation time did not match its original handle.");
      }
      interval = task.pollIntervalMs ?? interval;
      if (task.status === "completed") {
        taskId = undefined;
        if (!Array.isArray(task.result.content)) throw new McpOptionalFeatureError("MCP task completed without tool content.");
        return task.result;
      }
      if (task.status === "failed" || task.status === "cancelled") {
        taskId = undefined;
        return { content: [{ type: "text", text: "MCP task ended with status " + task.status + "." }], isError: true };
      }
      if (task.status === "input_required") {
        if (++updates > 8) throw new McpOptionalFeatureError("MCP task input round limit exceeded.");
        const inputResponses = await input(task.inputRequests);
        check();
        const reply = await options.request("tasks/update", { taskId, inputResponses }, signal);
        if (!UpdateTaskResultV2Schema.safeParse(reply).success) throw new McpOptionalFeatureError("MCP task update was not acknowledged.");
      }
    }
    throw new McpOptionalFeatureError("MCP task poll limit exceeded.");
  } catch (error) {
    if (taskId) {
      // Cancellation is best-effort; an acknowledgement is not proof the effect stopped.
      try {
        const reply = await options.request("tasks/cancel", { taskId }, AbortSignal.timeout(2000));
        if (!CancelTaskResultV2Schema.safeParse(reply).success) throw new Error("Invalid cancellation response");
      } catch { /* Preserve original error and unknown outcome. */ }
    }
    throw error;
  }
}
