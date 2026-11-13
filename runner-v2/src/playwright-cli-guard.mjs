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
  "until {pattern: 'Daemon listening on'}. Then run playwright-cli commands; they use that session.";

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

export function main(argv = process.argv.slice(2), environment = process.env) {
  const ownSession = environment.PLAYWRIGHT_CLI_SESSION || undefined;
  const refusal = refusalFor(argv, ownSession);
  if (refusal) {
    process.stderr.write(`Refused by AIBoard: ${refusal}\n`);
    process.exitCode = 2;
    return;
  }
  const roots = playwrightRoots();
  interceptNotOpen(process.stdout);
  interceptNotOpen(process.stderr);
  const cli = join(roots.playwright, "cli.js");
  process.argv = [process.argv[0], cli, "cli", ...argv];
  require(cli);
}

function isEntryPoint() {
  try { return Boolean(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; }
  catch { return false; }
}

if (isEntryPoint()) main();
