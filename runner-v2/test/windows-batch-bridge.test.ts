import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

// Exercise the real private serializer without running the bootstrap's top-level launch.
const source = fs.readFileSync(new URL("../src/portable-process-child.mjs", import.meta.url), "utf8");
const start = source.indexOf("function resolveWindowsArgvLaunch(command, args, cwd, environment) {");
assert.ok(start >= 0);
const declarations = source.slice(start);
type Launch = { executable: string; arguments: string[] };
function serializer(existsSync: (value: string) => boolean,
  paths: Pick<typeof path, "join" | "extname" | "isAbsolute" | "resolve" | "delimiter"> = path) {
  const context = vm.createContext({ Buffer, existsSync, join: paths.join, extname: paths.extname,
    isAbsolute: paths.isAbsolute, resolve: paths.resolve, delimiter: paths.delimiter });
  vm.runInContext(declarations, context);
  return context.resolveWindowsArgvLaunch as (command: string, args: string[], cwd: string,
    environment: Record<string, string>) => Launch;
}

test("batch bridge preserves actual argv and exit codes without PowerShell module autoload", {
  skip: process.platform !== "win32",
}, () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "aiboard-batch-bridge-"));
  const workspace = path.join(root, "workspace quote's space");
  fs.mkdirSync(workspace);
  const capture = path.join(workspace, "capture.mjs");
  fs.writeFileSync(capture, "process.stdout.write(JSON.stringify(process.argv.slice(2)));process.exit(Number(process.env.PROBE_EXIT));");
  const environment: Record<string, string> = {};
  for (const name of ["SystemRoot", "windir", "ComSpec", "Path", "PATHEXT", "TEMP", "TMP"]) {
    const key = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase());
    if (key && process.env[key] !== undefined) environment[name] = process.env[key]!;
  }
  Object.assign(environment, { NODE_EXE: process.execPath, PROBE_SCRIPT: capture });
  const launchFor = serializer(fs.existsSync);
  try {
    for (const fixture of [
      { extension: ".cmd", args: ["", "space value", "literal-value", "quote's", "λ雪😀", "\ud800", "\udc00", "a\ud800b", ""],
        // Windows PowerShell 5 native invocation already omits empty string arguments.
        // The native boundary normalizes lone UTF-16 surrogates to U+FFFD on the original bridge too.
        expected: ["space value", "literal-value", "quote's", "λ雪😀", "�", "�", "a�b"], exit: 0 },
      { extension: ".bat", args: [], expected: [], exit: 23 },
    ]) {
      const shim = path.join(workspace, "capture" + fixture.extension);
      fs.writeFileSync(shim, '@echo off\r\n"%NODE_EXE%" "%PROBE_SCRIPT%" %*\r\n');
      const launch = launchFor(shim, fixture.args, workspace, environment);
      assert.deepEqual(Array.from(launch.arguments.slice(0, -1)),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
      const originalScript = Buffer.from(launch.arguments.at(-1)!, "base64").toString("utf16le");
      const disabledAutoload = "$PSModuleAutoLoadingPreference='None';" + originalScript;
      const result = spawnSync(launch.executable, [...launch.arguments.slice(0, -1),
        Buffer.from(disabledAutoload, "utf16le").toString("base64")], {
        cwd: workspace, env: { ...environment, PROBE_EXIT: String(fixture.exit) }, windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024,
      });
      const facts = { extension: fixture.extension, status: result.status, signal: result.signal,
        error: result.error && { message: result.error.message, code: (result.error as NodeJS.ErrnoException).code },
        stdout: result.stdout, stderr: result.stderr };
      assert.equal(result.error, undefined, JSON.stringify(facts));
      assert.equal(result.signal, null, JSON.stringify(facts));
      assert.equal(result.stdout, JSON.stringify(fixture.expected), JSON.stringify(facts));
      assert.equal(result.stderr, "", JSON.stringify(facts));
      assert.equal(result.status, fixture.exit, JSON.stringify(facts));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("batch bridge keeps unsafe argument and unsupported launcher refusals", () => {
  const launchFor = serializer(() => true, path.win32);
  const environment = { SystemRoot: "C:\\Windows" };
  for (const character of ['"', "%", "!", "^", "&", "|", "<", ">", "(", ")", "\r", "\n"]) {
    assert.throws(() => launchFor("C:\\owned\\capture.cmd", ["before" + character + "after"], "C:\\owned", environment),
      /Unsafe \.cmd\/\.bat argument rejected before launch\./);
  }
  assert.throws(() => launchFor("C:\\owned\\capture.ps1", [], "C:\\owned", environment),
    /Unsupported Windows process launcher '\.ps1'\./);
  assert.throws(() => serializer((value) => !value.endsWith("powershell.exe"), path.win32)(
    "C:\\owned\\capture.cmd", [], "C:\\owned", environment), /Windows PowerShell is required/);
});

test("native exe and com argv still bypass the batch bridge unchanged", () => {
  const launchFor = serializer(() => true, path.win32);
  for (const extension of [".exe", ".com"]) {
    const args = ["", "unsafe&native", "\n", "λ雪"];
    const launch = launchFor("C:\\owned\\capture" + extension, args, "C:\\owned", {});
    assert.equal(launch.executable, "C:\\owned\\capture" + extension);
    assert.equal(launch.arguments, args);
  }
});

test("batch bridge keeps 1000 short safe arguments within the original Windows command-line envelope", () => {
  const launchFor = serializer(() => true, path.win32);
  const launch = launchFor("C:\\owned\\capture.cmd", Array(1000).fill("x"), "C:\\owned", { SystemRoot: "C:\\Windows" });
  const encoded = launch.arguments.at(-1)!;
  // Actual original source measured 14948 encoded characters for this fixed fixture.
  // Allow only small fixed script overhead; repeated per-argument decoder expressions fail this bound.
  assert.ok(encoded.length <= 14948 + 1024, "encoded command expanded to " + encoded.length);
  const commandLine = [launch.executable, ...launch.arguments].map((value) => '"' + value + '"').join(" ");
  assert.ok(commandLine.length + 1 < 32767, "Windows command line exceeds the native bound");
});
