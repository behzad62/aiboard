import { spawn } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";

const config = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8"));
const waiter = new Int32Array(new SharedArrayBuffer(4));

while (!existsSync(config.goPath)) Atomics.wait(waiter, 0, 0, 10);

const child = spawn(config.executable, config.arguments, {
  cwd: config.workingDirectory,
  env: config.environment,
  windowsHide: true,
  stdio: ["ignore", "inherit", "inherit"],
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
