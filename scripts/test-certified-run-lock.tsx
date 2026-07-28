import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { PresetCards } from "../components/benchmark/run/PresetCards";
import { createCertifiedRunLock } from "../lib/benchmark/certified/run-lock";

const lock = createCertifiedRunLock();

assert.equal(lock.tryAcquire("advanced"), true);
assert.equal(lock.tryAcquire("preset"), false);
assert.equal(lock.activeOwner(), "advanced");

lock.release("preset");
assert.equal(lock.activeOwner(), "advanced");
assert.equal(lock.tryAcquire("preset"), false);

lock.release("advanced");
assert.equal(lock.tryAcquire("preset"), true);
assert.equal(lock.activeOwner(), "preset");

const markup = renderToStaticMarkup(
  <PresetCards
    busy
    runningPresetId={null}
    focusedPresetId="model-iq"
    gates={{
      "model-iq": { disabled: false },
      "team-benchmark": { disabled: false },
      "full-certified": { disabled: false },
    }}
    onFocus={() => undefined}
    onRun={() => undefined}
  />
);

const runButtons = markup.match(/<button\b[^>]*>/g) ?? [];
assert.equal(runButtons.length, 3);
assert.ok(runButtons.every((button) => button.includes("disabled=\"\"")));

console.log("PASS");
