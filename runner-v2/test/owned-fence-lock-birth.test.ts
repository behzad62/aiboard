import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function inspectorSource(): string {
  const source = readFileSync(new URL("../src/owned-fence-lock.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function inspectProcessBirth(pid) {");
  const end = source.indexOf("\nexport function inspectGenericPosixProcessBirth", start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

test("Windows exact process birth does not require optional PowerShell cmdlet autoload", (t) => {
  if (process.platform !== "win32") { t.skip("Real Windows birth fixture requires Windows."); return; }
  let queries = 0;
  let nativeFailure: Record<string, unknown> | undefined;
  const context = vm.createContext({
    process: {
      platform: "win32",
      kill: (pid: number, signal: number) => {
        assert.equal(pid, process.pid);
        assert.equal(signal, 0);
        process.kill(pid, 0);
      },
    },
    execFileSync: (executable: string, args: string[], options: Record<string, unknown>) => {
      queries++;
      assert.equal(executable, "powershell.exe");
      assert.deepEqual(Array.from(args.slice(0, 4)), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
      assert.equal(args.length, 5);
      assert.equal(options.timeout, 2_000);
      assert.equal(options.encoding, "utf8");
      assert.equal(options.windowsHide, true);
      // One cold original query, with optional module autoload unavailable.
      // No preflight, warmer, retry, alternate native query or larger deadline.
      try {
        return execFileSync(executable, [...args.slice(0, 4), "$PSModuleAutoLoadingPreference='None';" + args[4]], options);
      } catch (error) {
        const detail = error as { code?: unknown; status?: unknown; signal?: unknown; stderr?: unknown };
        const stderr = typeof detail.stderr === "string" ? detail.stderr : Buffer.isBuffer(detail.stderr) ? detail.stderr.toString("utf8") : "";
        nativeFailure = {
          code: detail.code, status: detail.status, signal: detail.signal,
          missingGetProcessCommand: stderr.includes("Get-Process") && stderr.includes("CommandNotFoundException"),
        };
        throw error;
      }
    },
    normalizeBirth: (value: string) => value.replace(/(\.\d{6})\d+(Z)$/, "$1$2"),
  });
  vm.runInContext(inspectorSource(), context);
  const result = JSON.parse(JSON.stringify(vm.runInContext(`inspectProcessBirth(${process.pid})`, context)));
  assert.equal(queries, 1, "the genuine birth query must run exactly once");
  assert.equal(result.state, "same", "birth must remain available without cmdlet autoload; actual native failure=" + JSON.stringify(nativeFailure));
  assert.match(result.fingerprint, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/);
});

test("Windows birth query failures remain unknown while only genuine ESRCH proves absence", () => {
  const cases = [
    { name: "missing", existence: "ESRCH", expected: "absent" },
    { name: "permission", existence: "EPERM", expected: "unknown" },
    { name: "timeout", error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT", status: null, signal: "SIGTERM" }), expected: "unknown" },
    { name: "query-race-or-denied", error: new Error("native birth unavailable"), expected: "unknown" },
    { name: "empty", output: "", expected: "unknown" },
    { name: "malformed", output: "unavailable", expected: "unknown" },
    { name: "empty-birth", output: "PRESENT:", expected: "unknown" },
    { name: "exact", output: "PRESENT:2026-10-09T10:11:12.1234567Z\r\n", expected: "same" },
  ] as const;
  for (const fixture of cases) {
    let queries = 0;
    let signals = 0;
    const context = vm.createContext({
      process: {
        platform: "win32",
        kill: (pid: number, signal: number) => {
          signals++;
          assert.equal(pid, 4242);
          assert.equal(signal, 0);
          if ("existence" in fixture) throw Object.assign(new Error(fixture.existence), { code: fixture.existence });
        },
      },
      execFileSync: (_executable: string, _args: string[], options: Record<string, unknown>) => {
        queries++;
        assert.equal(options.timeout, 2_000);
        if ("error" in fixture) throw fixture.error;
        return "output" in fixture ? fixture.output : "";
      },
      normalizeBirth: (value: string) => value.replace(/(\.\d{6})\d+(Z)$/, "$1$2"),
    });
    vm.runInContext(inspectorSource(), context);
    const result = JSON.parse(JSON.stringify(vm.runInContext("inspectProcessBirth(4242)", context)));
    assert.equal(signals, 1, fixture.name);
    assert.equal(queries, "existence" in fixture ? 0 : 1, fixture.name);
    assert.deepEqual(result, fixture.expected === "same"
      ? { state: "same", fingerprint: "2026-10-09T10:11:12.123456Z" }
      : { state: fixture.expected }, fixture.name);
  }
});
