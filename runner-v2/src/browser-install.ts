// VF7b (plan §4.5, VD-4): a browser download happens only as the owner's own action. `aiboard browser install`
// runs Playwright's Chromium install from the Playwright the Runner ships; the Settings > Tools button asks the
// Runner (POST /v2/browser/install), which runs that same command as a Runner-internal process and shows its
// output as it comes. A Build never calls either. On Linux the system libraries Chromium needs are installed
// with root, which AIBoard never does: it says so and prints the command.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunnerInternalProcessKernel } from "./runner-internal-process-kernel.js";
import { loadPlaywrightRegistry, PLAYWRIGHT_BROWSER_ORDER } from "./verification-inventory.js";

export interface InstalledBrowserView {
  readonly id: string;
  readonly installed: boolean;
  readonly path?: string;
}

interface InstallRegistry {
  findExecutable(name: string): { executablePath(language?: string): string | undefined } | undefined;
  resolveBrowsers?(aliases: string[], options: Record<string, unknown>): unknown[];
  install?(executables: unknown[], options: { force?: boolean }): Promise<void>;
  validateHostRequirementsForExecutablesIfNeeded?(executables: unknown[], language: string): Promise<void>;
}

/** Chrome, Edge and Playwright's Chromium, from the bundled Playwright's registry (no launch). */
export function installedBrowsers(registry: () => InstallRegistry = loadPlaywrightRegistry as unknown as () => InstallRegistry): InstalledBrowserView[] {
  const found = registry();
  return PLAYWRIGHT_BROWSER_ORDER.map((id) => {
    let path: string | undefined;
    try { path = found.findExecutable(id)?.executablePath("javascript") || undefined; } catch { path = undefined; }
    return path && existsSync(path) ? { id, installed: true, path } : { id, installed: false };
  });
}

function bundledPlaywrightCli(): string {
  return join(dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js");
}

/** The root-only command for Chromium's Linux libraries, with the Playwright AIBoard ships. */
export function linuxDependenciesCommand(node = process.execPath): string {
  return `sudo "${node}" "${bundledPlaywrightCli()}" install-deps chromium`;
}

export const LINUX_LIBRARIES_NOTE =
  "On Linux, Chromium also needs system libraries. Installing them needs root, so AIBoard never does it. " +
  "Run this yourself if the browser does not start (it is the same as npx playwright install-deps chromium):";

/**
 * `aiboard browser install`: downloads Playwright's Chromium into Playwright's own browser folder, with the
 * bundled Playwright's progress output. Only an owner types it; nothing in a Build runs it.
 */
export async function runBrowserCommand(args: readonly string[], options: {
  write?: (text: string) => void;
  platform?: NodeJS.Platform;
  registry?: () => InstallRegistry;
} = {}): Promise<void> {
  const write = options.write ?? ((text: string) => { process.stdout.write(text); });
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    write(browserHelp());
    return;
  }
  if (args[0] !== "install" || args.length > 1) throw new Error("invalid_arguments: Expected aiboard browser install. See aiboard browser --help.");
  const registry = (options.registry ?? (loadPlaywrightRegistry as unknown as () => InstallRegistry))();
  if (typeof registry.resolveBrowsers !== "function" || typeof registry.install !== "function") {
    throw new Error("browser_install_unavailable: The bundled Playwright cannot install browsers.");
  }
  const before = installedBrowsers(() => registry);
  const system = before.filter((browser) => browser.installed && browser.id !== "chromium").map((browser) => browser.id === "chrome" ? "Google Chrome" : "Microsoft Edge");
  if (system.length > 0) write(`${system.join(" and ")} ${system.length > 1 ? "are" : "is"} installed already; Builds use ${system[0]} first. Installing Playwright's Chromium as well.\n`);
  write("Installing Playwright's Chromium (a download of about 150 MB)...\n");
  const executables = registry.resolveBrowsers(["chromium"], {});
  await registry.install(executables, { force: false });
  await registry.validateHostRequirementsForExecutablesIfNeeded?.(executables, "javascript").catch((error: unknown) => {
    write(`Playwright reports missing host requirements: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n`);
  });
  const after = installedBrowsers(() => registry).find((browser) => browser.id === "chromium");
  if (!after?.installed) throw new Error("browser_install_failed: Playwright's Chromium is still not installed.");
  write(`Playwright's Chromium is installed: ${after.path}\n`);
  if ((options.platform ?? process.platform) === "linux") write(`${LINUX_LIBRARIES_NOTE}\n  ${linuxDependenciesCommand()}\n`);
  write("New Builds can browse with the Playwright CLI now.\n");
}

export function browserHelp(): string {
  return [
    "Usage: aiboard browser install",
    "  Downloads Playwright's Chromium for the Playwright CLI that Builds browse with.",
    "  Builds use an installed Google Chrome first, then Microsoft Edge, then this Chromium.",
    "  A Build never downloads a browser itself.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- the Runner side of the Settings button

export interface BrowserInstallState {
  readonly status: "idle" | "running" | "succeeded" | "failed";
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly exitCode?: number | null;
  /** The command's latest output lines, newest last (bounded). */
  readonly output: readonly string[];
  readonly browsers: readonly InstalledBrowserView[];
  /** Linux only: the root-only libraries command the owner runs themself. */
  readonly linuxLibraries?: { readonly note: string; readonly command: string };
}

const MAX_OUTPUT_LINES = 60;
/** A browser download on a slow link; the command's own retries fit inside it. */
export const BROWSER_INSTALL_DEADLINE_MS = 15 * 60_000;

export class BrowserInstallService {
  private state: { status: BrowserInstallState["status"]; startedAt?: string; finishedAt?: string; exitCode?: number | null; output: string[] } = { status: "idle", output: [] };
  private running: Promise<void> | undefined;

  constructor(private readonly options: {
    readonly processKernel: Pick<RunnerInternalProcessKernel, "launch">;
    readonly environment: Readonly<Record<string, string>>;
    readonly workingDirectory: string;
    readonly platform?: NodeJS.Platform;
    readonly node?: string;
    readonly launcher?: string;
    readonly browsers?: () => InstalledBrowserView[];
    readonly now?: () => Date;
  }) {}

  view(): BrowserInstallState {
    let browsers: InstalledBrowserView[] = [];
    try { browsers = (this.options.browsers ?? installedBrowsers)(); } catch { browsers = []; }
    return Object.freeze({
      status: this.state.status,
      ...(this.state.startedAt ? { startedAt: this.state.startedAt } : {}),
      ...(this.state.finishedAt ? { finishedAt: this.state.finishedAt } : {}),
      ...(this.state.exitCode !== undefined ? { exitCode: this.state.exitCode } : {}),
      output: Object.freeze([...this.state.output]),
      browsers: Object.freeze(browsers),
      ...((this.options.platform ?? process.platform) === "linux" ? { linuxLibraries: { note: LINUX_LIBRARIES_NOTE, command: linuxDependenciesCommand(this.options.node) } } : {}),
    });
  }

  /** Starts the install unless one is running; the owner's button is the only caller. */
  start(): BrowserInstallState {
    if (this.running) return this.view();
    const now = this.options.now ?? (() => new Date());
    this.state = { status: "running", startedAt: now().toISOString(), output: [] };
    this.running = this.run(now).finally(() => { this.running = undefined; });
    return this.view();
  }

  /** Tests: settles when the current install finishes. */
  async settled(): Promise<void> {
    await this.running;
  }

  private append(text: string): void {
    const lines = text.replace(/\r(?!\n)/g, "\n").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
    for (const line of lines) {
      // Progress bars repeat one line; keep the newest of a run of the same prefix.
      const previous = this.state.output.at(-1);
      if (previous && /^\|/.test(line) && /^\|/.test(previous)) this.state.output[this.state.output.length - 1] = line;
      else this.state.output.push(line);
    }
    if (this.state.output.length > MAX_OUTPUT_LINES) this.state.output.splice(0, this.state.output.length - MAX_OUTPUT_LINES);
  }

  private async run(now: () => Date): Promise<void> {
    const node = this.options.node ?? process.execPath;
    const launcher = this.options.launcher ?? fileURLToPath(new URL("../bin/aiboard.mjs", import.meta.url));
    let exitCode: number | null = null;
    try {
      const owned = await this.options.processKernel.launch({
        principalId: `browser-install-${randomUUID()}`,
        callId: `browser-install-${randomUUID()}`,
        runId: "runner-browser-install",
        kind: "command",
        executable: node,
        arguments: [launcher, "browser", "install"],
        workingDirectory: this.options.workingDirectory,
        environment: this.options.environment,
        access: [],
      });
      const decoder = { stdout: new TextDecoder(), stderr: new TextDecoder() };
      owned.setOutputSink((metadata, chunk) => { this.append(decoder[metadata.stream === "stderr" ? "stderr" : "stdout"].decode(chunk, { stream: true })); });
      const deadline = Date.now() + BROWSER_INSTALL_DEADLINE_MS;
      let timedOut = false;
      while ((await owned.reconcile()).state !== "exited") {
        if (Date.now() > deadline) { timedOut = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const disposition = await owned.closeVerified({ shutdownTimeoutMs: timedOut ? 1 : 15_000, terminationTimeoutMs: 15_000 });
      exitCode = timedOut ? null : disposition.exitCode ?? null;
      if (timedOut) this.append(`The install did not finish in ${BROWSER_INSTALL_DEADLINE_MS / 60_000} minutes and was stopped.`);
    } catch (error) {
      this.append(`The install could not run: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.state = { ...this.state, status: exitCode === 0 ? "succeeded" : "failed", finishedAt: now().toISOString(), exitCode };
  }
}
