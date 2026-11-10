import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { bashExecutable, pwshExecutable, type ShellName } from "./shell-inventory.js";

/**
 * Models write commands the way a shell tool takes them: one line, such as `npm test` or
 * `cd /d D:\proj && git add a.txt && git commit -m "x"`. A `command` with no `args` and a space in it is such a
 * line, so it runs in the platform shell (cmd.exe on Windows, bash elsewhere), exactly as an explicit shell and
 * script would: the same capability, the same approval and the same owned process tree.
 *
 * A path with a space in it, such as C:\Program Files\nodejs\node.exe, is still one program when it names an
 * existing file. (Live 2026-11-10: `cd /d D:\proj && git add ... && git commit ...` sent as command failed with
 * "Process launch was not proven", and the model split every later commit into separate calls.)
 */
export function commandLineShell(
  command: string,
  args: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): "cmd" | "bash" | undefined {
  if (args !== undefined && args.length > 0) return undefined;
  const line = command.trim();
  if (!/\s/u.test(line)) return undefined;
  if (isAbsolute(line) && existsSync(line)) return undefined;
  return platform === "win32" ? "cmd" : "bash";
}

/** The invocation that runs script in shell. One place, so a command line and an explicit shell launch alike. */
export function shellInvocation(shell: ShellName, script: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  switch (shell) {
    case "powershell":
      return { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script] };
    case "pwsh":
      return { command: pwshExecutable(platform) ?? (platform === "win32" ? "pwsh.exe" : "pwsh"), args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script] };
    case "cmd":
      return { command: "cmd.exe", args: ["/d", "/s", "/c", script] };
    // Git Bash on Windows, without its login profile, which can cd to the home folder; a login shell elsewhere, as before.
    case "bash":
      return platform === "win32" ? { command: bashExecutable(platform) ?? "bash.exe", args: ["-c", script] } : { command: "bash", args: ["-lc", script] };
  }
}
