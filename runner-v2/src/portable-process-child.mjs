import { spawn } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";

const config = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8"));
const waiter = new Int32Array(new SharedArrayBuffer(4));

while (!existsSync(config.goPath)) Atomics.wait(waiter, 0, 0, 10);

let launch;
try {
  launch = process.platform === "win32"
    ? resolveWindowsArgvLaunch(config.executable, config.arguments, config.workingDirectory, config.environment)
    : { executable: config.executable, arguments: config.arguments };
} catch (error) {
  publish({ status: "error", error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}

const child = spawn(launch.executable, launch.arguments, {
  cwd: config.workingDirectory,
  env: config.environment,
  windowsHide: true,
  stdio: ["inherit", "inherit", "inherit"],
});
child.once("error", (error) => {
  publish({ status: "error", error: error.message });
  process.exit(1);
});
child.once("spawn", () => publish({ status: "started" }));
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

function publish(value) {
  const temporary = `${config.statusPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, config.statusPath);
}

function resolveWindowsArgvLaunch(command, args, cwd, environment) {
  const resolved = resolveWindowsCommand(command, cwd, environment);
  const extension = extname(resolved).toLowerCase();
  if (extension === ".exe" || extension === ".com") return { executable: resolved, arguments: args };
  if (extension !== ".cmd" && extension !== ".bat") throw new Error(`Unsupported Windows process launcher '${extension}'.`);
  for (const argument of args) {
    if (/["%!^&|<>()\r\n]/.test(argument)) throw new Error("Unsafe .cmd/.bat argument rejected before launch.");
  }
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? process.env.SystemRoot;
  const powershell = systemRoot ? join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "";
  if (!powershell || !existsSync(powershell)) throw new Error("Windows PowerShell is required for argv-only batch launch.");
  const payload = Buffer.from(JSON.stringify({ command: resolved, args })).toString("base64");
  const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;$a=@($p.args|ForEach-Object{[string]$_});& ([string]$p.command) @a;if($null-eq$LASTEXITCODE){exit 0}else{exit $LASTEXITCODE}`;
  return { executable: powershell, arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] };
}

function resolveWindowsCommand(command, cwd, environment) {
  if (typeof command !== "string" || !command.trim()) throw new Error("Process command must not be empty.");
  const hasDirectory = /[\\/]/.test(command);
  const bases = isAbsolute(command) ? [command] : hasDirectory ? [resolve(cwd, command)] : [join(cwd, command), ...(environment.PATH ?? environment.Path ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory.replace(/^"|"$/g, ""), command))];
  const extensions = extname(command) ? [""] : (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((value) => value.startsWith(".") ? value : `.${value}`);
  for (const extension of extensions) for (const base of bases) { const candidate = `${base}${extension}`; if (existsSync(candidate)) return resolve(candidate); }
  throw new Error(`Windows process command was not found on PATH: ${command}`);
}
