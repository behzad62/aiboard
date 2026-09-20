import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createQualificationFixtureRoot,
  deferQualificationFixtureRemoval,
  exitScenarioMain,
  skipQualificationScenario,
} from "./qualification-harness.js";

const mode = process.env.RUNNER_V2_HARNESS_PROBE_MODE ?? "pass";

if (mode === "text-skip-only") {
  console.log("SKIP synthetic unstructured harness probe");
  process.exit(0);
}

await exitScenarioMain(async () => {
  if (mode === "skip") skipQualificationScenario("synthetic harness probe");
  const root = createQualificationFixtureRoot("harness-probe");
  const channel = join(root, "channel");
  mkdirSync(join(channel, "output"), { recursive: true });
  mkdirSync(join(channel, "ack"), { recursive: true });
  writeFileSync(join(root, "state.json"), JSON.stringify({ mode, marker: "durable-state" }));
  writeFileSync(join(channel, "output", "stdout-000000000001.json"), JSON.stringify({ marker: "retained-output" }));
  writeFileSync(join(channel, "ack", "stderr-000000000002.json"), JSON.stringify({ marker: "retained-ack" }));
  deferQualificationFixtureRemoval(root);

  if (mode === "fail") throw new Error("synthetic harness probe failure");
  if (mode === "timeout") {
    setInterval(() => undefined, 1_000);
    await new Promise<never>(() => undefined);
  }
});
