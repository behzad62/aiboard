// RUNNER_RAW_PROCESS_BOUNDARY: asks a detected powershell.exe / pwsh for its version once per Runner start; runs only
// that shell with a fixed $PSVersionTable query, no profile, bounded by a 10 s timeout, with no secrets.
import { execFile } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/** A shell process.run can be asked for. pwsh is PowerShell 7 and later, powershell is Windows PowerShell 5.1. */
export type ShellName = "powershell" | "pwsh" | "cmd" | "bash";
export const SHELL_NAMES: readonly ShellName[] = ["powershell", "pwsh", "cmd", "bash"];

/**
 * The shells this device has, each with its version where a shell reports one: "cmd", "powershell 5.1", "pwsh 7.6",
 * "bash". The Runner learns them once, in the background, so a client can pick the shell it writes for (devices_list
 * shows them). Nothing here decides access: a shell script needs the same grant whichever shell runs it.
 */
let inventory: Promise<readonly string[]> | undefined;
let known: readonly string[] | undefined;

export function shellInventory(platform: NodeJS.Platform = process.platform): Promise<readonly string[]> {
  inventory ??= detect(platform).then((shells) => (known = shells), () => (known = []));
  return inventory;
}

/** The inventory once it is known; undefined while it is still being learned. */
export function knownShells(): readonly string[] | undefined {
  return known;
}

/** True unless the inventory is known and lacks shell: an unknown inventory never refuses a launch. */
export function shellMayRun(shell: ShellName): boolean {
  return known === undefined || known.some((entry) => entry.split(" ")[0] === shell);
}

/**
 * The bash a script runs in. On Windows that is Git Bash: a bash.exe on PATH that is not WSL's launcher (System32,
 * WindowsApps), else the one Git for Windows installs beside the git.exe on PATH, else its default folder.
 */
let gitBash: string | null | undefined;
export function bashExecutable(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "win32") return onPath("bash");
  if (gitBash !== undefined) return gitBash ?? undefined;
  const systemRoot = (process.env.SystemRoot ?? "C:\\Windows").toLowerCase();
  const wsl = (directory: string) => directory.startsWith(join(systemRoot, "system32")) || storeApps(directory);
  const fromPath = onPath("bash.exe", wsl);
  const git = onPath("git.exe", wsl);
  // Git for Windows puts git.exe in <root>\cmd or <root>\mingw64\bin, and bash.exe in <root>\bin.
  const root = git ? /^(.*?)\\(?:cmd|mingw64\\bin|bin)\\git\.exe$/iu.exec(git)?.[1] : undefined;
  const candidates = [fromPath, root && join(root, "bin", "bash.exe"), join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")];
  gitBash = candidates.find((candidate): candidate is string => typeof candidate === "string" && existsSync(candidate)) ?? null;
  return gitBash ?? undefined;
}

async function detect(platform: NodeJS.Platform): Promise<readonly string[]> {
  const windows = platform === "win32";
  const systemPowerShell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const pwsh = pwshExecutable(platform);
  const bash = bashExecutable(platform);
  const [powershellVersion, pwshVersion] = await Promise.all([
    windows && existsSync(systemPowerShell) ? powerShellVersion(systemPowerShell) : Promise.resolve(undefined),
    pwsh ? powerShellVersion(pwsh) : Promise.resolve(undefined),
  ]);
  return [
    ...(windows ? ["cmd"] : []),
    ...(powershellVersion ? ["powershell " + powershellVersion] : []),
    ...(pwshVersion ? ["pwsh " + pwshVersion] : []),
    ...(bash ? ["bash"] : []),
  ];
}

function onPath(name: string, excluded: (directory: string) => boolean = () => false): string | undefined {
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    if (!directory || excluded(directory.replace(/[\\/]+$/u, "").toLowerCase())) continue;
    const candidate = join(directory, name);
    if (present(candidate)) return candidate;
  }
  return undefined;
}

/** A Store app's command (WindowsApps\pwsh.exe) is an app execution alias: stat cannot follow it, but it launches. */
function present(path: string): boolean {
  if (existsSync(path)) return true;
  try { lstatSync(path); return true; } catch { return false; }
}

/**
 * The pwsh a script runs in: the path found on PATH, so the launch needs no search of its own. That may be the
 * Microsoft Store's pwsh (an alias under WindowsApps). A packaged program's children are created outside the Runner's
 * Job by default, and the Job host's desktop app policy (managed-process-job-host.ps1 StartSuspended) is what keeps
 * them in, so a stop still reaches them. (Measured 2026-11-10 with Store pwsh 7.6.9 starting node: without the
 * policy node outlived the stop; with it node died with the Job.)
 */
let pwshPath: string | null | undefined;
export function pwshExecutable(platform: NodeJS.Platform = process.platform): string | undefined {
  if (pwshPath === undefined) pwshPath = onPath(platform === "win32" ? "pwsh.exe" : "pwsh") ?? null;
  return pwshPath ?? undefined;
}

/** True for a Microsoft Store app's command, an app execution alias under WindowsApps. */
export function isStoreAppAlias(path: string): boolean {
  return storeApps(dirname(path).replace(/[\\/]+$/u, "").toLowerCase());
}

/** %LOCALAPPDATA%\Microsoft\WindowsApps and the per-app folders under it hold Store app aliases. */
function storeApps(directory: string): boolean {
  return /\\microsoft\\windowsapps(?:\\|$)/u.test(directory) || /\\program files\\windowsapps(?:\\|$)/u.test(directory);
}

/** major.minor, as $PSVersionTable reports it; undefined when the shell does not answer within 10 s. */
function powerShellVersion(executable: string): Promise<string | undefined> {
  return new Promise((done) => {
    execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$v=$PSVersionTable.PSVersion; \"$($v.Major).$($v.Minor)\""],
      { timeout: 10_000, windowsHide: true }, (error, stdout) => {
        const version = /^\d{1,3}\.\d{1,3}$/u.exec(String(stdout).trim())?.[0];
        done(error || !version ? undefined : version);
      });
  });
}
