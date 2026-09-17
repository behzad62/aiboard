import assert from "node:assert/strict";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (name: string) => fs.readFileSync(join(src, name), "utf8");

const ordinaryLifecycleSources = [
  "subprocess-runtime.ts",
  "durable-process-store.ts",
  "process-backend.ts",
  "windows-process-backend.ts",
  "posix-process-backend.ts",
  "execution-grants.ts",
  "execution-host.ts",
  "one-shot-command-executor.ts",
  "streaming-process-session-runtime.ts",
  "session-authority.ts",
] as const;

test("ordinary process lifecycle has no model invocation dependency", () => {
  for (const name of ordinaryLifecycleSources) {
    const source = read(name);
    assert.doesNotMatch(source, /\bAgentModel\b/,
      `${name} must not import or depend on an agent model`);
    assert.doesNotMatch(source, /createAgentProcessRecoveryGenerator/,
      `${name} must not construct the exceptional proposal generator`);
    assert.doesNotMatch(source, /\bmodel\s*\.\s*complete\s*\(/,
      `${name} must not invoke a model`);
  }
});

test("only exceptional recovery composition can construct the proposal model generator", () => {
  const references = fs.readdirSync(src)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => read(name).includes("createAgentProcessRecoveryGenerator"))
    .sort();
  assert.deepEqual(references, ["native-build-factory.ts", "process-recovery.ts"]);
});

test("ordinary execution host never dispatches exceptional recovery implicitly", () => {
  assert.doesNotMatch(read("execution-host.ts"), /\.recoverExceptional\s*\(/);
  assert.doesNotMatch(read("one-shot-command-executor.ts"), /\.recoverExceptional\s*\(/);
  assert.doesNotMatch(read("streaming-process-session-runtime.ts"), /\.recoverExceptional\s*\(/);
});
