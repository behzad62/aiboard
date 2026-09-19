import { spawn } from "node:child_process";
// RUNNER_RAW_PROCESS_BOUNDARY: portable child bootstrap launches only the already-authorized workload behind durable ownership.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import {
  inspectPosixProcessIdentity,
  isExactPosixAnchorRelease,
  parsePosixBootstrapGo,
} from "./portable-process-posix-control.mjs";
import { runPortableFenceEffectSync } from "./portable-process-protocol.mjs";

const config = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8"));
const waiter = new Int32Array(new SharedArrayBuffer(4));

if (config.platform === "posix") runPosixBootstrap();
else runWindowsBootstrap();

function runPosixBootstrap() {
  const identity = inspectPosixProcessIdentity(process.pid);
  if (identity.state !== "present" || identity.value.groupId !== process.pid) {
    publishPosixStatus({ status: "error", error: "POSIX bootstrap did not become its detached workload group leader." });
    process.exit(1);
  }
  const workloadGroup = {
    groupId: identity.value.groupId,
    leaderPid: process.pid,
    leaderBirth: identity.value.birth,
  };
  const expectedSupervisor = configuredPosixSupervisorAuthority();
  publishAtomic(config.preparedPath, {
    protocol: "aiboard-portable-process/v2-posix-prepared",
    nonce: config.nonce,
    ...workloadGroup,
  });
  publishPosixStatus({ status: "prepared", workloadGroup });
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  const go = waitForPosixBarrier(workloadGroup, expectedSupervisor);
  if (!go) return;
  let targetSettled = false;
  let targetFinished = false;
  const launch = { executable: config.executable, arguments: config.arguments };
  let child;
  try {
    child = spawn(launch.executable, launch.arguments, {
      cwd: config.workingDirectory,
      env: config.environment,
      windowsHide: true,
      stdio: ["inherit", "inherit", "inherit"],
    });
  } catch (error) {
    targetSettled = true;
    publishPosixStatus({ status: "error", error: error instanceof Error ? error.message : String(error), workloadGroup });
    waitForAnchorRelease(workloadGroup, () => targetSettled, expectedSupervisor);
    return;
  }
  child.once("error", (error) => {
    if (targetFinished) return;
    targetFinished = true;
    targetSettled = true;
    publishPosixStatus({ status: "error", error: error.message, workloadGroup });
  });
  child.once("spawn", () => publishPosixStatus({ status: "started", pid: child.pid, workloadGroup }));
  child.once("exit", (code, signal) => {
    if (targetFinished) return;
    targetFinished = true;
    targetSettled = true;
    publishPosixStatus({ status: "exited", exitCode: code, signal, workloadGroup });
  });
  waitForAnchorRelease(workloadGroup, () => targetSettled, expectedSupervisor);
}

function waitForPosixBarrier(workloadGroup, expectedSupervisor) {
  for (;;) {
    if (consumeExactPosixAnchorRelease(workloadGroup, expectedSupervisor)) {
      process.exit(0);
      return undefined;
    }
    if (existsSync(config.goPath)) {
      const go = parsePosixBootstrapGo(readJson(config.goPath), config.nonce, workloadGroup);
      if (samePosixSupervisorAuthority(go, expectedSupervisor)) return go;
      publishPosixStatus({ status: "error", error: "POSIX bootstrap go barrier identity is invalid.", workloadGroup });
      return waitForAnchorRelease(workloadGroup, () => true, expectedSupervisor);
    }
    Atomics.wait(waiter, 0, 0, 10);
  }
}

function waitForAnchorRelease(workloadGroup, targetSettled, expectedSupervisor) {
  const timer = setInterval(() => {
    if (!targetSettled()) return;
    if (!consumeExactPosixAnchorRelease(workloadGroup, expectedSupervisor)) return;
    clearInterval(timer);
    process.exit(0);
  }, 10);
}

function configuredPosixSupervisorAuthority() {
  const value = config.posixSupervisor;
  if (!value || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.birth !== "string" || value.birth.length === 0)
    return undefined;
  return { supervisorPid: value.pid, supervisorBirth: value.birth };
}

function samePosixSupervisorAuthority(value, expected) {
  return !!value && !!expected && value.supervisorPid === expected.supervisorPid && value.supervisorBirth === expected.supervisorBirth;
}

function readCurrentPosixFence(expectedSupervisor) {
  if (!expectedSupervisor) return undefined;
  const supervisor = inspectPosixProcessIdentity(expectedSupervisor.supervisorPid);
  if (supervisor.state !== "present" || supervisor.value.pid !== expectedSupervisor.supervisorPid ||
      supervisor.value.birth !== expectedSupervisor.supervisorBirth) return undefined;
  const holder = readJson(config.lockHolderPath);
  if (!holder || holder.nonce !== config.nonce || holder.holderPid !== expectedSupervisor.supervisorPid ||
      holder.holderBirth !== expectedSupervisor.supervisorBirth) return undefined;
  const fence = readJson(config.fencePath);
  return fence && fence.nonce === config.nonce && typeof fence.ownerId === "string" && fence.ownerId.length > 0 &&
    Number.isSafeInteger(fence.fencingToken) && fence.fencingToken >= 1 ? fence : undefined;
}

function readAnchorReleaseFence(value) {
  return value && typeof value.ownerId === "string" && value.ownerId.length > 0 &&
    Number.isSafeInteger(value.fencingToken) && value.fencingToken >= 1
    ? { ownerId: value.ownerId, fencingToken: value.fencingToken }
    : undefined;
}

function consumeExactPosixAnchorRelease(workloadGroup, expectedSupervisor) {
  if (!expectedSupervisor) return false;
  const release = readJson(config.anchorReleasePath);
  const expectedFence = readAnchorReleaseFence(release);
  if (!expectedFence) return false;
  const outcome = runPortableFenceEffectSync({
    lockPath: config.fenceLockPath,
    expectedFence,
    readCurrentFence: () => {
      const current = readCurrentPosixFence(expectedSupervisor);
      if (!current) throw new Error("POSIX anchor release authority is unavailable.");
      return current;
    },
    effect: () => {
      const current = readCurrentPosixFence(expectedSupervisor);
      const latestRelease = readJson(config.anchorReleasePath);
      if (!current || !isExactPosixAnchorRelease(latestRelease, config.nonce, workloadGroup, expectedSupervisor, current)) return false;
      publishPosixStatus({ status: "released", workloadGroup, anchorRelease: latestRelease });
      return true;
    },
    lockOptions: { holderPid: process.pid, holderBirth: workloadGroup.leaderBirth },
  });
  return outcome.status === "applied" && outcome.value === true;
}

function publishPosixStatus(value) {
  publishAtomic(config.statusPath, {
    protocol: "aiboard-portable-process/v2-posix-child",
    nonce: config.nonce,
    ...value,
  });
}

function publishAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function runWindowsBootstrap() {
  while (!existsSync(config.goPath)) Atomics.wait(waiter, 0, 0, 10);

  let launch;
  try {
    launch = process.platform === "win32"
      ? resolveWindowsArgvLaunch(config.executable, config.arguments, config.workingDirectory, config.environment)
      : { executable: config.executable, arguments: config.arguments };
  } catch (error) {
    publishWindows({ status: "error", error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }

  const child = spawn(launch.executable, launch.arguments, {
    cwd: config.workingDirectory,
    env: config.environment,
    windowsHide: true,
    stdio: ["inherit", "inherit", "inherit"],
  });
  child.once("error", (error) => {
    publishWindows({ status: "error", error: error.message });
    process.exit(1);
  });
  child.once("spawn", () => publishWindows({ status: "started" }));
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

function publishWindows(value) {
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
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT;
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
