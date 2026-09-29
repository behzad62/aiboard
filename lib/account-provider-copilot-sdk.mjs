import { CopilotClient, ToolSet } from "@github/copilot-sdk";

const SDK_MAX_OUTPUT_TOKENS = 128_000;

function sdkReasoningEffort(value) {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  if (value === "max") return "xhigh";
  return undefined;
}

function boundedMaxOutputTokens(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(Math.trunc(parsed), SDK_MAX_OUTPUT_TOKENS);
}

function messageText(message) {
  return typeof message?.content === "string" ? message.content.trim() : "";
}

export function copilotSdkPromptFromMessages(messages) {
  const promptParts = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const content = messageText(message);
    if (!content || message?.role === "system") continue;
    if (promptParts.length === 0 && message?.role === "user") {
      promptParts.push(content);
      continue;
    }
    const label = message?.role === "assistant" ? "Assistant" : "User";
    promptParts.push(`${label}:\n${content}`);
  }
  return promptParts.join("\n\n").trim();
}

export function copilotSdkSystemMessageFromMessages(messages) {
  const systemMessages = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === "system")
    .map(messageText)
    .filter(Boolean);
  return systemMessages.join("\n\n").trim();
}

export function copilotSdkPermissionHandler(request) {
  // The discussion adapter deliberately exposes only the two web tools. The
  // URL permission is needed by web_fetch; every other permission kind would
  // be a host capability outside the scope of a browser discussion.
  if (request?.kind === "url") return { kind: "approve-once" };
  return {
    kind: "reject",
    feedback: "Only Copilot web search and web fetch are allowed in this discussion session.",
  };
}

function bodyToolEnabled(body, capabilityId) {
  return Array.isArray(body?.toolIntents) && body.toolIntents.some((intent) => intent?.id === capabilityId);
}

export function buildCopilotSdkSessionConfig(body) {
  const tools = new ToolSet();
  if (bodyToolEnabled(body, "web_search")) {
    tools.addBuiltIn("web_search").addBuiltIn("web_fetch");
  }
  const systemMessage = copilotSdkSystemMessageFromMessages(body?.messages);
  const maxOutputTokens = boundedMaxOutputTokens(body?.maxTokens);
  return {
    ...(body?.model && body.model !== "auto" ? { model: body.model } : {}),
    ...(sdkReasoningEffort(body?.reasoningEffort)
      ? { reasoningEffort: sdkReasoningEffort(body.reasoningEffort) }
      : {}),
    ...(systemMessage
      ? { systemMessage: { mode: "append", content: systemMessage } }
      : {}),
    availableTools: tools,
    onPermissionRequest: copilotSdkPermissionHandler,
    ...(maxOutputTokens
      ? { modelCapabilities: { limits: { max_output_tokens: maxOutputTokens } } }
      : {}),
  };
}

function runnerToolCapability(id, execution, transports) {
  return {
    id,
    support: "supported",
    execution,
    transports,
    supportSource: "runner",
  };
}

export function buildCopilotSdkRunnerCapabilities(models = []) {
  const seen = new Set();
  const modelRecords = [];
  for (const model of Array.isArray(models) ? models : []) {
    const modelId = String(model?.id ?? "").trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    modelRecords.push({ modelId, capabilities: [] });
  }
  return {
    transports: ["copilot_sdk", "runner_proxy"],
    capabilities: [
      runnerToolCapability("web_search", "runner", ["copilot_sdk"]),
      runnerToolCapability("web_fetch", "runner", ["copilot_sdk"]),
    ],
    models: modelRecords,
    execution: [
      { id: "streaming", available: true, transports: ["copilot_sdk"] },
      { id: "model_discovery", available: true, transports: ["copilot_sdk"] },
      { id: "structured_output_fallback", available: true, transports: ["runner_proxy"] },
      { id: "attachment_fallback", available: true, transports: ["runner_proxy"] },
    ],
  };
}
function defaultClientFactory(options) {
  return new CopilotClient(options);
}

export async function listCopilotSdkModels(
  githubToken,
  baseDirectory,
  { clientFactory = defaultClientFactory } = {}
) {
  const client = clientFactory({
    mode: "empty",
    baseDirectory,
    workingDirectory: baseDirectory,
    gitHubToken: githubToken,
    useLoggedInUser: false,
    logLevel: "error",
  });
  try {
    await client.start();
    return await client.listModels();
  } finally {
    try { await client.stop?.(); } catch {}
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new Error("Copilot SDK request aborted.");
}

export async function runCopilotSdkChat(
  body,
  githubToken,
  baseDirectory,
  onToken,
  { signal, clientFactory = defaultClientFactory } = {}
) {
  const client = clientFactory({
    mode: "empty",
    baseDirectory,
    workingDirectory: baseDirectory,
    gitHubToken: githubToken,
    useLoggedInUser: false,
    logLevel: "error",
  });
  let session;
  let unsubscribe;
  let emittedText = "";
  let abortPromise;
  const abortSession = () => {
    if (abortPromise || !session?.abort) return;
    try {
      abortPromise = Promise.resolve(session.abort()).catch(() => {});
    } catch {
      abortPromise = Promise.resolve();
    }
  };
  try {
    throwIfAborted(signal);
    await client.start();
    throwIfAborted(signal);
    session = await client.createSession(buildCopilotSdkSessionConfig(body));
    if (signal?.aborted) abortSession();
    else signal?.addEventListener("abort", abortSession, { once: true });
    throwIfAborted(signal);
    unsubscribe = session.on("assistant.message_delta", (event) => {
      const delta = typeof event?.data?.deltaContent === "string" ? event.data.deltaContent : "";
      if (!delta) return;
      emittedText += delta;
      onToken?.(delta);
    });
    throwIfAborted(signal);
    const result = await session.sendAndWait(
      { prompt: copilotSdkPromptFromMessages(body?.messages) },
      120_000
    );
    throwIfAborted(signal);
    const content = typeof result?.data?.content === "string" ? result.data.content : "";
    if (!emittedText && content) onToken?.(content);
    return content;
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortSession);
    if (signal?.aborted) abortSession();
    await abortPromise;
    try { unsubscribe?.(); } catch {}
    try { await session?.disconnect?.(); } catch {}
    try { await client.stop?.(); } catch {}
  }
}
