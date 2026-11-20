// A CliWorkerProcesses double for the CLI worker tests (CW3): real child processes (node + the fake CLI), whose session
// stop is proven by waiting for every child's exit, or reported unproven on demand. Each start's scenario follows the
// CLI path the detection resolved. The real execution-host path is cli-worker-processes.test.ts.
import { spawn } from "node:child_process";

import type { CliWorkerProcess, CliWorkerProcesses, CliWorkerProcessOutput, CliWorkerProcessSession } from "../../src/cli-worker-processes.js";
import { FAKE_CLI_SCENARIO_ENV, FAKE_CLI_SCRIPT } from "./fake-cli.js";


export type Purpose = "check" | "test";

export interface FakeLaunch { purpose: Purpose; workingDirectory: string; executable: string; args: string[] }

export interface FakeProcesses extends CliWorkerProcesses {
  opens: Array<{ purpose: Purpose; workingDirectory: string }>;
  launches: FakeLaunch[];
  closes: Array<{ purpose: Purpose; verified: boolean }>;
  /** Faults by purpose: the binding does not open, a start throws the aggregate, a read throws, the stop is unproven. */
  fail: Partial<Record<"open" | "start" | "read" | "stop", Purpose>>;
  launched(purpose: Purpose): FakeLaunch[];
}

export function fakeProcesses(scenarios: ReadonlyMap<string, string>): FakeProcesses {
  const self: FakeProcesses = {
    opens: [],
    launches: [],
    closes: [],
    fail: {},
    launched: (purpose) => self.launches.filter((launch) => launch.purpose === purpose),
    async open({ purpose, workingDirectory }): Promise<CliWorkerProcessSession> {
      if (self.fail.open === purpose) throw new Error("The run binding could not open.");
      self.opens.push({ purpose, workingDirectory });
      const children: Array<{ kill(): void; closed: Promise<void> }> = [];
      let closing: Promise<void> | undefined;
      return {
        async start({ executable, args }): Promise<CliWorkerProcess> {
          self.launches.push({ purpose, workingDirectory, executable, args: [...args] });
          if (self.fail.start === purpose) {
            // What ManagedProcessService throws when a start failed after the process may have been born.
            throw new AggregateError([new Error("spawn reported no exit")], "Process start failed; process cleanup remains owned by the Runner.");
          }
          const scenario = scenarios.get(executable);
          if (!scenario) throw new Error(`no fake CLI for ${executable}`);
          const child = spawn(process.execPath, [FAKE_CLI_SCRIPT, ...args], {
            cwd: workingDirectory,
            env: { ...process.env, [FAKE_CLI_SCENARIO_ENV]: scenario },
            stdio: "pipe",
            windowsHide: true,
          });
          let stdout = "", stderr = "", allStdout = "", allStderr = "", exited = false, exitCode: number | null = null;
          let wake: (() => void) | undefined;
          const signal = () => { const resolve = wake; wake = undefined; resolve?.(); };
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (text: string) => { stdout += text; allStdout += text; signal(); });
          child.stderr.on("data", (text: string) => { stderr += text; allStderr += text; signal(); });
          child.on("error", () => undefined);
          child.stdin.on("error", () => undefined);
          const closed = new Promise<void>((resolve) => child.on("close", (code) => { exited = true; exitCode = code; signal(); resolve(); }));
          children.push({ kill: () => { if (!exited) child.kill(); }, closed });
          return {
            async closeInput(text?: string) {
              if (text) child.stdin.write(text);
              child.stdin.end();
            },
            async read(waitMs: number): Promise<CliWorkerProcessOutput> {
              if (self.fail.read === purpose) throw new Error("The output could not be read.");
              if (!stdout && !stderr && !exited) {
                await new Promise<void>((resolve) => {
                  const timer = setTimeout(resolve, waitMs);
                  wake = () => { clearTimeout(timer); resolve(); };
                });
              }
              // This double keeps every byte, so it never skips a stretch (the real host's live tail does).
              const output = { stdout, stderr, gap: false, exited, exitCode };
              stdout = "";
              stderr = "";
              return output;
            },
            rewind() {
              stdout = allStdout;
              stderr = allStderr;
            },
          };
        },
        async close() {
          closing ??= (async () => {
            for (const child of children) child.kill();
            await Promise.all(children.map((child) => child.closed));
            const verified = self.fail.stop !== purpose;
            self.closes.push({ purpose, verified });
            if (!verified) throw new AggregateError([new Error("Job emptiness was not proven.")], "CLI worker processes could not be proven stopped.");
          })();
          return await closing;
        },
      };
    },
  };
  return self;
}

