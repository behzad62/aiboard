// Run from the bundled Node on each release host; no account or model call is needed.
// The bundle ships only the Copilot runtime pin: this downloads the pinned package exactly as the Runner does on
// first use, verifies it, then starts it through the bundled SDK and pings it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCopilotSmoke } from "./copilot-smoke-control.mjs";

const bundle = resolve(process.argv[2] ?? "app");
const app = join(bundle, "app");
const platformPackage = join(app, "node_modules", "@github", `copilot-${process.platform}-${process.arch}`);
if (existsSync(platformPackage)) throw new Error("The release bundle still carries the Copilot platform package; it must be downloaded on first use.");
const runtime = await import(pathToFileURL(join(app, "runner-v2", "src", "copilot-runtime.js")).href);
const pin = await runtime.readBundledCopilotPin(join(app, "runner-v2", "copilot-runtime.json"));
if (!pin) throw new Error("The release bundle has no Copilot runtime pin.");
const state = mkdtempSync(join(tmpdir(), "aiboard-copilot-smoke-"));
const cli = await runtime.ensureCopilotRuntime({ pin, root: join(state, "runtimes"), log: (line) => console.log(line) });
console.log(execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8", timeout: 60_000, windowsHide: true }).trim());

await import(pathToFileURL(join(app, "lib", "account-provider-copilot-sdk.mjs")).href);
const { CopilotClient } = await import(pathToFileURL(join(app, "node_modules", "@github", "copilot-sdk", "dist", "index.js")).href);
const env = { HOME: state, USERPROFILE: state, TMP: state, TEMP: state, COPILOT_DISABLE_KEYTAR: "1" };
for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL"]) {
  if (process.env[key]) env[key] = process.env[key];
}
const client = new CopilotClient({ mode: "empty", useLoggedInUser: false, baseDirectory: state, workingDirectory: state, env,
  connection: { kind: "stdio", path: cli } });
if (realpathSync(client.resolvedCliPath) !== realpathSync(cli)) throw new Error("Copilot SDK resolved a runtime other than the verified download.");
await runCopilotSmoke(client);
console.log(`Copilot runtime ${pin.version} downloaded and verified; the SDK started it, it answered a local ping, and closed; retained test state at ${state}.`);
