import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../app/settings/settings-client.tsx", import.meta.url), "utf8");

assert.match(source, /<TabsTrigger value="capability-lab">Capability Lab<\/TabsTrigger>/, "Capability Lab should be a top-level Settings tab");
assert.match(source, /<TabsContent value="capability-lab"[^>]*>[\s\S]*?<CapabilityLab/, "Capability Lab content should live in its own tab");

const providersStart = source.indexOf('<TabsContent value="providers"');
const providersEnd = source.indexOf('</TabsContent>', providersStart);
const labWithinProviders = source.indexOf('<CapabilityLab', providersStart);
assert.ok(providersStart >= 0 && providersEnd > providersStart, "Providers tab must exist");
assert.ok(labWithinProviders < 0 || labWithinProviders > providersEnd, "Capability Lab must not be nested inside Providers");

console.log("PASS Capability Lab is a standalone Settings tab, not provider configuration");
