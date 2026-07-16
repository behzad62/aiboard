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

export function buildCopilotSdkSessionConfig(body) {
  const tools = new ToolSet();
  if (body?.webSearch) {
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

function defaultClientFactory(options) {
  return new CopilotClient(options);
}

export async function runCopilotSdkChat(
  body,
  githubToken,
  baseDirectory,
  onToken,
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
  let session;
  let unsubscribe;
  let emittedText = "";
  try {
    await client.start();
    session = await client.createSession(buildCopilotSdkSessionConfig(body));
    unsubscribe = session.on("assistant.message_delta", (event) => {
      const delta = typeof event?.data?.deltaContent === "string" ? event.data.deltaContent : "";
      if (!delta) return;
      emittedText += delta;
      onToken?.(delta);
    });
    const result = await session.sendAndWait(
      { prompt: copilotSdkPromptFromMessages(body?.messages) },
      120_000
    );
    const content = typeof result?.data?.content === "string" ? result.data.content : "";
    if (!emittedText && content) onToken?.(content);
    return content;
  } finally {
    try { unsubscribe?.(); } catch {}
    try { await session?.disconnect?.(); } catch {}
    try { await client.stop?.(); } catch {}
  }
}
