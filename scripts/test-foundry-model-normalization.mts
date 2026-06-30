import { normalizeFoundryModelId } from "../lib/client/providers";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

check(
  "raw Foundry deployment id is preserved",
  normalizeFoundryModelId("claude-opus-4-5") === "claude-opus-4-5"
);

check(
  "full Foundry model id is normalized to deployment id",
  normalizeFoundryModelId("foundry:claude-opus-4-5") === "claude-opus-4-5",
  normalizeFoundryModelId("foundry:claude-opus-4-5")
);

check(
  "normalization trims whitespace",
  normalizeFoundryModelId("  foundry:claude-opus-4-5  ") === "claude-opus-4-5"
);

if (failures > 0) {
  process.exit(1);
}
