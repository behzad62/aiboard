import type { ToolAction } from "@/lib/orchestrator/build";

export interface BuildMcpToolValidation {
  allowed: boolean;
  message?: string;
  guidance?: string;
}

export interface BuildMcpToolValidationState {
  playwrightNavigated?: boolean;
}

export interface BuildMcpPromptTool {
  name: string;
  description?: string | null;
}

export interface BuildMcpPromptServer<TTool extends BuildMcpPromptTool = BuildMcpPromptTool> {
  name: string;
  tools: TTool[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPlaywrightTool(action: ToolAction): boolean {
  const server = action.server.toLowerCase();
  const tool = action.tool.toLowerCase();
  return server.includes("playwright") || tool.startsWith("browser_");
}

function isPlaywrightPromptTool(serverName: string, toolName: string): boolean {
  const server = serverName.toLowerCase();
  const tool = toolName.toLowerCase();
  return server.includes("playwright") || tool.startsWith("browser_");
}

function isUnsafePlaywrightPromptTool(serverName: string, tool: BuildMcpPromptTool): boolean {
  const name = tool.name.toLowerCase();
  const description = (tool.description ?? "").toLowerCase();
  return (
    isPlaywrightPromptTool(serverName, tool.name) &&
    (name.includes("run_code") ||
      name.includes("unsafe") ||
      /\bunsafe\b/.test(description))
  );
}

export function filterBuildMcpToolsForPrompt<T extends BuildMcpPromptServer>(
  server: T
): T {
  return {
    ...server,
    tools: server.tools.filter((tool) => !isUnsafePlaywrightPromptTool(server.name, tool)),
  };
}

export function shouldRetryPlaywrightNavigateAfterClosedTarget(
  action: ToolAction,
  outputText: string
): boolean {
  const server = action.server.toLowerCase();
  const tool = action.tool.toLowerCase();
  return (
    (server.includes("playwright") || tool.startsWith("browser_")) &&
    tool === "browser_navigate" &&
    /\btarget page, context or browser has been closed\b/i.test(outputText)
  );
}

function functionText(args: Record<string, unknown> | undefined): string {
  const fn = args?.function;
  return typeof fn === "string" ? fn : "";
}

function codeText(args: Record<string, unknown> | undefined): string {
  const code = args?.code;
  return typeof code === "string" ? code : "";
}

function containsNodeOnlyCode(source: string): boolean {
  return (
    /\brequire\s*\(/i.test(source) ||
    /\bchild_process\b/i.test(source) ||
    /\bexecSync\b|\bspawnSync\b|\bexecFileSync\b/i.test(source) ||
    /\bexec\s*\(/i.test(source) ||
    /\bprocess\.(?:cwd|env|exit|versions|platform)\b/i.test(source) ||
    /\bnode:[a-z_/.-]+/i.test(source) ||
    /\bnpm\s+(?:run|test|install|start|exec)\b/i.test(source)
  );
}

export function validateBuildMcpToolAction(
  action: ToolAction,
  state: BuildMcpToolValidationState = {}
): BuildMcpToolValidation {
  if (!isPlaywrightTool(action)) return { allowed: true };

  const args = isRecord(action.args) ? action.args : {};
  const tool = action.tool.toLowerCase();

  if (tool === "browser_navigate") {
    const url = args.url;
    if (typeof url !== "string" || !url.trim()) {
      return {
        allowed: false,
        message:
          "Playwright browser_navigate requires the exact argument name `url` with a non-empty URL.",
        guidance:
          'Use {"action":"tool","server":"playwright","tool":"browser_navigate","args":{"url":"http://127.0.0.1:3000"},"reason":"open the app"} and then use snapshot/evaluate tools to inspect the page.',
      };
    }
    if (/^about:blank$/i.test(url.trim())) {
      return {
        allowed: false,
        message:
          "Playwright browser_navigate must open the app or page under test, not about:blank.",
        guidance:
          'Use the actual app under test URL, for example {"action":"tool","server":"playwright","tool":"browser_navigate","args":{"url":"http://127.0.0.1:3000"},"reason":"open the app under test"}.',
      };
    }
  }

  if (tool === "browser_console_messages") {
    const level = args.level;
    if (
      level != null &&
      (typeof level !== "string" ||
        !["error", "warning", "info", "debug"].includes(level))
    ) {
      return {
        allowed: false,
        message:
          "Playwright browser_console_messages only accepts level values: error, warning, info, or debug.",
        guidance:
          'Use one of error, warning, info, or debug, for example {"action":"tool","server":"playwright","tool":"browser_console_messages","args":{"level":"error"},"reason":"inspect browser errors"} or omit level if the tool supports its default.',
      };
    }
  }

  if (tool === "browser_evaluate") {
    const source = functionText(args);
    if (!source.trim()) {
      return {
        allowed: false,
        message:
          "Playwright browser_evaluate requires a `function` string that runs in the page.",
        guidance:
          'Use {"action":"tool","server":"playwright","tool":"browser_evaluate","args":{"function":"() => document.title"},"reason":"inspect the page"} for DOM checks.',
      };
    }
    if (containsNodeOnlyCode(source)) {
      return {
        allowed: false,
        message:
          "Playwright browser_evaluate runs in the browser page context, not Node, so it cannot use require, child_process, process.cwd, or shell commands.",
        guidance:
          'For shell checks use a runner command such as {"action":"run","command":"npm run check","reason":"run project checks"}. Use browser_evaluate only for DOM/page-state inspection after browser_navigate.',
      };
    }
    if (!state.playwrightNavigated) {
      return {
        allowed: false,
        message:
          "Playwright browser_evaluate requires a successful browser_navigate first so the page target is open and scoped to the app under test.",
        guidance:
          'First call {"action":"tool","server":"playwright","tool":"browser_navigate","args":{"url":"http://127.0.0.1:3000"},"reason":"open the app"}, then call browser_evaluate for DOM/page-state inspection.',
      };
    }
  }

  if (tool.includes("run_code") || tool.includes("evaluate")) {
    const source = codeText(args) || functionText(args);
    if (containsNodeOnlyCode(source)) {
      return {
        allowed: false,
        message:
          "Playwright MCP code tools run in a browser/MCP context, not the project shell, so they cannot use require, child_process, process.cwd, npm, or shell commands.",
        guidance:
          'For shell checks use a runner command such as {"action":"run","command":"npm run check","reason":"run project checks"}. Use Playwright only for navigation, snapshots, and DOM/page-state inspection.',
      };
    }
  }

  return { allowed: true };
}
