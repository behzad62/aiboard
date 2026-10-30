// Run from the bundled Node on each release host; no account or model call is needed.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCopilotSmoke } from "./copilot-smoke-control.mjs";

const bundle = resolve(process.argv[2] ?? "app");
const nodeModules = join(bundle, "app", "node_modules");
const platform = process.platform === "win32" ? "win32" : process.platform;
const cli = realpathSync(join(nodeModules, "@github", `copilot-${platform}-${process.arch}`, "index.js"));
await import(pathToFileURL(join(bundle, "app", "lib", "account-provider-copilot-sdk.mjs")).href);
const { CopilotClient } = await import(pathToFileURL(join(nodeModules, "@github", "copilot-sdk", "dist", "index.js")).href);
const state = mkdtempSync(join(tmpdir(), "aiboard-copilot-smoke-"));
const env = { HOME: state, USERPROFILE: state, TMP: state, TEMP: state, COPILOT_DISABLE_KEYTAR: "1" };
for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL"]) {
  if (process.env[key]) env[key] = process.env[key];
}
const client = new CopilotClient({ mode: "empty", useLoggedInUser: false, baseDirectory: state, workingDirectory: state, env });
if (realpathSync(client.resolvedCliPath) !== cli) throw new Error("Copilot SDK resolved a runtime outside the release bundle.");
await runCopilotSmoke(client);
console.log(`Copilot SDK started, answered a local ping, and closed; retained test state at ${state}.`);
