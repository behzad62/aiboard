// VF7b: the `playwright-cli` command the Runner puts on PATH for the processes it starts. It runs the Playwright
// CLI the Runner ships (`playwright/cli.js cli ...`), so its version always matches the AIBoard browser skill.
// It is a guardrail, not a boundary: it refuses the commands and options that would start a browser outside the
// agent session's own managed `playwright-cli-session` process, or reach another session, and says what to do
// instead. A model can still run the CLI's files directly, at the same trust level as any other command.
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

export const START_INSTRUCTION =
  "Start this agent session's browser once with process.start: command playwright-cli-session, no args, " +
  "until {pattern: 'Daemon listening on'}. Then run playwright-cli commands; they use that session. " +
  "In a final check, make playwright-cli-session the start check's program (ready {outputLine: 'Daemon listening on'}) " +
  "and run playwright-cli in its steps.";

/** Commands that start, attach, show, install or kill outside the managed session. */
const REFUSED_COMMANDS = new Map([
  ["open", `playwright-cli open starts a browser this Runner does not own, so it is refused. ${START_INSTRUCTION} Use playwright-cli goto <url> to open a page.`],
  ["attach", `playwright-cli attach connects to a browser this Runner does not own, so it is refused. ${START_INSTRUCTION}`],
  ["show", "playwright-cli show starts a detached dashboard, so it is refused. Use snapshot, screenshot or console instead."],
  ["install", "playwright-cli install downloads software, which a Build never does. The owner installs a browser with: aiboard browser install."],
  ["install-browser", "playwright-cli install-browser downloads a browser, which a Build never does. The owner installs one with: aiboard browser install."],
  ["close-all", "playwright-cli close-all would close other sessions' browsers, so it is refused. Use playwright-cli close to stop this session's browser."],
  ["kill-all", "playwright-cli kill-all would kill other sessions' browsers, so it is refused. Use playwright-cli close, or process.signal on the playwright-cli-session process."],
  ["delete-data", "playwright-cli delete-data is for persistent profiles, which this Runner does not use, so it is refused."],
]);

/** Options that point the CLI at another browser or a persistent profile. */
const REFUSED_OPTIONS = new Map([
  ["cdp", "--cdp connects to a browser this Runner does not own, so it is refused."],
  ["endpoint", "--endpoint connects to a browser this Runner does not own, so it is refused."],
  ["extension", "--extension connects to your own browser through its extension, so it is refused."],
  ["profile", "--profile uses a persistent browser profile, so it is refused: the session's profile lives in its task folder."],
  ["persistent", "--persistent keeps a browser profile on disk, so it is refused: the session's profile lives in its task folder."],
]);

const NOT_OPEN = /(?:The browser|Browser) '([^']*)' is not open(?:, please run open first|\. Run)?/g;
const OPEN_HINT_LINE = /^\s*playwright-cli(?: -s=\S+)? open(?: \[params\])?\s*$/;
const TRAILER_LINE = /^to (?:re)?start the browser session\.$/;

function playwrightRoots() {
  const playwrightManifest = require.resolve("playwright/package.json");
  const playwright = dirname(playwrightManifest);
  const core = dirname(createRequire(playwrightManifest).resolve("playwright-core/package.json"));
  return { playwright, core };
}

/** The CLI's own argument reading (minimist with its boolean options), so the command found here is its command. */
export function parseCliArguments(argv, roots = playwrightRoots()) {
  const { minimist } = require(join(roots.core, "lib", "tools", "cli-client", "minimist.js"));
  const help = require(join(roots.core, "lib", "tools", "cli-client", "help.json"));
  const boolean = [...(help.booleanOptions ?? []), "help", "json", "raw", "version"];
  return minimist(argv, { boolean, string: ["_"] });
}

/** Undefined when the arguments may run; otherwise the refusal text. */
export function refusalFor(argv, ownSession, parse = parseCliArguments) {
  const args = parse(argv);
  const command = args._?.[0];
  if (typeof command === "string" && REFUSED_COMMANDS.has(command)) return REFUSED_COMMANDS.get(command);
  for (const [name, text] of REFUSED_OPTIONS) {
    if (args[name] !== undefined && args[name] !== false) return text;
  }
  for (const name of ["s", "session"]) {
    const value = args[name];
    if (value === undefined) continue;
    if (!ownSession) return `-s/--session is refused here: this command is not running for a Build agent session. ${START_INSTRUCTION}`;
    const values = Array.isArray(value) ? value : [value];
    if (values.some((entry) => String(entry) !== ownSession)) {
      return `-s/--session names another browser session, so it is refused: each agent session uses only its own (${ownSession}), and playwright-cli uses it without -s.`;
    }
  }
  return undefined;
}

/** The CLI's "please run open first" becomes the instruction that works here. */
export function rewriteNotOpen(text) {
  if (!text.includes("is not open") && !OPEN_HINT_LINE.test(text) && !text.includes("browser session.")) return text;
  const lines = text.split(/(\r?\n)/);
  const out = [];
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index] ?? "";
    const newline = lines[index + 1] ?? "";
    if (OPEN_HINT_LINE.test(line) || TRAILER_LINE.test(line.trim())) continue;
    out.push(line.replace(NOT_OPEN, (_match, session) => `Browser session '${session}' is not running. ${START_INSTRUCTION}`), newline);
  }
  return out.join("");
}

function interceptNotOpen(stream) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    if (typeof chunk === "string") return write(rewriteNotOpen(chunk), encoding, callback);
    if (chunk instanceof Uint8Array) return write(rewriteNotOpen(Buffer.from(chunk).toString("utf8")), typeof encoding === "function" ? encoding : callback);
    return write(chunk, encoding, callback);
  };
}

// The CLI prints a failed command's result and still exits 0 (its client's default branch prints the tool result
// whatever it holds). Its response puts the Error section before every other one, so with --json a failed result is an
// object whose first key is "isError": true, and as text it starts with "### Error". Both are recognised from the start
// of the output, so a large snapshot is never buffered. Raw output (--raw, or a command the CLI prints raw by default,
// such as cookie-get or response-body) has no section headings: it is the value itself, which the page controls, so it
// is never read for a failure.
const JSON_FAILURE = /^\s*\{\s*"isError"\s*:\s*true\b/;
const RESULT_PREFIX_CHARS = 4_096;

/** How the CLI prints these arguments' result: "json" (--json), "raw" (no --json; --raw or a raw command) or "text". */
export function cliOutputMode(argv, roots = playwrightRoots(), parse = parseCliArguments) {
  const args = parse(argv, roots);
  if (args.json === true) return "json";
  if (args.raw === true) return "raw";
  const command = args._?.[0];
  const help = require(join(roots.core, "lib", "tools", "cli-client", "help.json"));
  return typeof command === "string" && help.commands?.[command]?.raw === true ? "raw" : "text";
}

/** True when the CLI's printed output, in that mode, is a failed command's result. */
export function cliOutputFailed(output, mode) {
  if (mode === "json") return JSON_FAILURE.test(output);
  if (mode !== "text") return false;
  const first = output.split(/\r?\n/).find((line) => line.trim() !== "");
  return first?.trim() === "### Error";
}

/** A failed command exits 1, so a final check's step and an agent's process.run both see it fail. */
function failOnErrorResult(stream, mode) {
  let prefix = "";
  const write = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    if (prefix.length < RESULT_PREFIX_CHARS) {
      const text = typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : "";
      prefix += text.slice(0, RESULT_PREFIX_CHARS - prefix.length);
    }
    return write(chunk, encoding, callback);
  };
  process.on("exit", () => {
    if (!process.exitCode && cliOutputFailed(prefix, mode)) process.exitCode = 1;
  });
}

/**
 * The client side of the session command's sanitizing (playwright-cli.ts): no PLAYWRIGHT_MCP_* but the output
 * folder, and the global Playwright CLI config read from the owner's state folder, never the user's home.
 */
export function sanitizeCliEnvironment(environment, platform = process.platform) {
  for (const name of Object.keys(environment)) {
    const upper = platform === "win32" ? name.toUpperCase() : name;
    if (upper.startsWith("PLAYWRIGHT_MCP_") && upper !== "PLAYWRIGHT_MCP_OUTPUT_DIR") delete environment[name];
  }
  if (environment.AIBOARD_PLAYWRIGHT_STATE) environment.PWTEST_CLI_GLOBAL_CONFIG = join(environment.AIBOARD_PLAYWRIGHT_STATE, "global");
  return environment;
}

export function main(argv = process.argv.slice(2), environment = process.env) {
  const ownSession = environment.PLAYWRIGHT_CLI_SESSION || undefined;
  const refusal = refusalFor(argv, ownSession);
  if (refusal) {
    process.stderr.write(`Refused by AIBoard: ${refusal}\n`);
    process.exitCode = 2;
    return;
  }
  sanitizeCliEnvironment(environment);
  const roots = playwrightRoots();
  interceptNotOpen(process.stdout);
  interceptNotOpen(process.stderr);
  failOnErrorResult(process.stdout, cliOutputMode(argv, roots));
  const cli = join(roots.playwright, "cli.js");
  process.argv = [process.argv[0], cli, "cli", ...argv];
  require(cli);
}

function isEntryPoint() {
  try { return Boolean(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; }
  catch { return false; }
}

if (isEntryPoint()) main();
