/** Runner browser-client timeout checks (run: npx tsx scripts/test-runner-client-timeout.mts) */
import { runCommand, type RunnerConfig } from "../lib/client/runner";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const realFetch = globalThis.fetch;
const config: RunnerConfig = { url: "http://127.0.0.1:8787/", token: "secret-token" };
let sawAbortSignal = false;
let sawAbort = false;

function installHangingFetch() {
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    sawAbortSignal = signal instanceof AbortSignal;
    return await new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => {
          sawAbort = true;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        },
        { once: true }
      );
    });
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

async function main() {
  installHangingFetch();
  const result = await Promise.race([
    runCommand(config, "long-running-command", { timeoutMs: 25 }).then(
      () => ({ kind: "resolved" as const }),
      (err) => ({
        kind: "rejected" as const,
        message: err instanceof Error ? err.message : String(err),
      })
    ),
    new Promise<{ kind: "hung" }>((resolve) =>
      setTimeout(() => resolve({ kind: "hung" }), 500)
    ),
  ]);
  restoreFetch();

  check("runCommand sends an AbortSignal", sawAbortSignal);
  check("runCommand aborts a hung request", sawAbort);
  check("runCommand rejects instead of hanging", result.kind === "rejected", result);
  check(
    "runCommand surfaces timeout message",
    result.kind === "rejected" && result.message.includes("timed out"),
    result
  );

  console.log(failed === 0 ? "\nAll runner client timeout checks passed." : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  restoreFetch();
  check("runner client timeout checks", false, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
