import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("components/CapabilityLab.tsx", "utf8");
assert.match(source, /General model tests/);
assert.match(source, /Tool tests for this provider\/model/);
assert.match(source, /getCapabilityLabProbeCatalog\(selectedModelId\)/);
assert.match(source, /Select all available tools/);
assert.match(source, /probe\.readiness === "available"/);
assert.match(source, /probe\.execution/);
assert.match(source, /probe\.transports\.join/);
assert.match(source, /probe\.reason/);
assert.doesNotMatch(source, />Capability tests</);
console.log("PASS Capability Lab renders dynamic provider tool tests separately from general probes");
