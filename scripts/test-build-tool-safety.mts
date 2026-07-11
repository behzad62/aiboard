/** Build MCP tool safety checks (run: npx tsx scripts/test-build-tool-safety.mts) */
import {
  filterBuildMcpToolsForPrompt,
  shouldRetryPlaywrightNavigateAfterClosedTarget,
  validateBuildMcpToolAction,
} from "../lib/orchestrator/build-tool-safety";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const unsafeEvaluate = validateBuildMcpToolAction({
  action: "tool",
  server: "playwright",
  tool: "browser_evaluate",
  args: {
    function:
      "() => { const { execSync } = require('child_process'); return execSync('npm run check 2>&1').toString(); }",
  },
  reason: "run project checks",
});

check("Playwright browser_evaluate cannot run Node require", unsafeEvaluate.allowed === false, unsafeEvaluate);
check(
  "unsafe evaluate guidance points to run actions",
  /browser page context/i.test(unsafeEvaluate.message) && /action\":\"run/i.test(unsafeEvaluate.guidance ?? ""),
  unsafeEvaluate
);

const missingUrl = validateBuildMcpToolAction({
  action: "tool",
  server: "playwright",
  tool: "browser_navigate",
  args: { href: "http://127.0.0.1:3000" },
  reason: "open app",
});

check("Playwright navigate requires exact url arg", missingUrl.allowed === false, missingUrl);
check("navigate guidance names url", /\"url\"/.test(missingUrl.guidance ?? ""), missingUrl);

const goodNavigate = validateBuildMcpToolAction({
  action: "tool",
  server: "playwright",
  tool: "browser_navigate",
  args: { url: "http://127.0.0.1:3000" },
  reason: "open app",
});

check("valid Playwright navigate is allowed", goodNavigate.allowed === true, goodNavigate);

check(
  "closed Playwright navigate target is retryable",
  shouldRetryPlaywrightNavigateAfterClosedTarget(
    {
      action: "tool",
      server: "playwright",
      tool: "browser_navigate",
      args: { url: "http://127.0.0.1:3000" },
      reason: "open app",
    },
    "### Error\nError: browserBackend.callTool: Target page, context or browser has been closed"
  ),
);

check(
  "non-navigation Playwright errors are not retryable",
  !shouldRetryPlaywrightNavigateAfterClosedTarget(
    {
      action: "tool",
      server: "playwright",
      tool: "browser_evaluate",
      args: { function: "() => document.title" },
      reason: "read title",
    },
    "### Error\nError: Target page, context or browser has been closed"
  ),
);

check(
  "ordinary navigation failures are not masked by closed-target retry",
  !shouldRetryPlaywrightNavigateAfterClosedTarget(
    {
      action: "tool",
      server: "playwright",
      tool: "browser_navigate",
      args: { url: "http://127.0.0.1:39999" },
      reason: "open app",
    },
    "### Error\nnet::ERR_CONNECTION_REFUSED"
  ),
);

const blankNavigate = validateBuildMcpToolAction({
  action: "tool",
  server: "playwright",
  tool: "browser_navigate",
  args: { url: "about:blank" },
  reason: "reset browser",
});

check("Playwright navigate rejects about:blank", blankNavigate.allowed === false, blankNavigate);
check("about:blank guidance asks for app URL", /app under test/i.test(blankNavigate.guidance ?? ""), blankNavigate);

const goodEvaluate = validateBuildMcpToolAction({
  action: "tool",
  server: "playwright",
  tool: "browser_evaluate",
  args: { function: "() => document.title" },
  reason: "read page title",
}, { playwrightNavigated: true });

check("DOM-only browser_evaluate is allowed after navigation", goodEvaluate.allowed === true, goodEvaluate);

const evaluateBeforeNavigate = validateBuildMcpToolAction({
  action: "tool",
  server: "playwright",
  tool: "browser_evaluate",
  args: { function: "() => document.title" },
  reason: "read page title",
});

check("browser_evaluate requires prior navigation", evaluateBeforeNavigate.allowed === false, evaluateBeforeNavigate);
check("evaluate-before-navigation guidance names browser_navigate", /browser_navigate/.test(evaluateBeforeNavigate.guidance ?? ""), evaluateBeforeNavigate);

const unsafeRunCode = validateBuildMcpToolAction({
  action: "tool",
  server: "playwright",
  tool: "browser_run_code_unsafe",
  args: {
    code:
      "const { exec } = require('child_process'); exec('npm run check', { cwd: process.cwd() });",
  },
  reason: "run checks",
});

check("Playwright unsafe code tool cannot run shell commands", unsafeRunCode.allowed === false, unsafeRunCode);
check("unsafe code tool guidance points to run actions", /action\":\"run/.test(unsafeRunCode.guidance ?? ""), unsafeRunCode);

const badConsoleLevel = validateBuildMcpToolAction({
  action: "tool",
  server: "playwright",
  tool: "browser_console_messages",
  args: { level: "all", all: true },
  reason: "inspect browser console",
});

check("Playwright console messages rejects invalid all level", badConsoleLevel.allowed === false, badConsoleLevel);
check("console level guidance names valid levels", /error.*warning.*info.*debug/i.test(badConsoleLevel.guidance ?? ""), badConsoleLevel);

const millisecondStyleWait = validateBuildMcpToolAction({
  action: "tool",
  server: "playwright",
  tool: "browser_wait_for",
  args: { time: 2500 },
  reason: "wait for animation",
});
check(
  "Playwright wait rejects likely millisecond values",
  millisecondStyleWait.allowed === false,
  millisecondStyleWait
);
check(
  "Playwright wait guidance explains seconds and the likely conversion",
  /seconds/i.test(millisecondStyleWait.guidance ?? "") &&
    /2\.5/.test(millisecondStyleWait.guidance ?? ""),
  millisecondStyleWait
);

const secondsWait = validateBuildMcpToolAction({
  action: "tool",
  server: "playwright",
  tool: "browser_wait_for",
  args: { time: 2.5 },
  reason: "wait for animation",
});
check("Playwright wait accepts bounded seconds", secondsWait.allowed === true, secondsWait);

const filtered = filterBuildMcpToolsForPrompt({
  name: "playwright",
  status: "ready",
  tools: [
    { name: "browser_navigate", description: "Navigate", inputSchema: {} },
    { name: "browser_run_code_unsafe", description: "Run unsafe code", inputSchema: {} },
    { name: "browser_evaluate", description: "Evaluate in page", inputSchema: {} },
  ],
});

check(
  "unsafe Playwright code tools are hidden from Build MCP prompt docs",
  filtered.tools.map((tool) => tool.name).join(",") === "browser_navigate,browser_evaluate",
  filtered
);

process.exit(failed === 0 ? 0 : 1);
