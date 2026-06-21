/** Discussion model-count validation checks (run: npx tsx scripts/test-discussion-model-count.mts) */
import {
  hasEnoughParticipatingModels,
  minimumParticipatingModelsForMode,
  participatingModelRequirementMessage,
} from "../lib/client/api";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

check("build mode requires only one participating model", minimumParticipatingModelsForMode("build") === 1);
check("panel mode still requires two participating models", minimumParticipatingModelsForMode("panel") === 2);
check("debate mode still requires two participating models", minimumParticipatingModelsForMode("debate") === 2);
check("specialist mode still requires two participating models", minimumParticipatingModelsForMode("specialist") === 2);

check("build mode accepts one participating model", hasEnoughParticipatingModels("build", 1));
check("build mode rejects zero participating models", !hasEnoughParticipatingModels("build", 0));
check("panel mode rejects one participating model", !hasEnoughParticipatingModels("panel", 1));
check("panel mode accepts two participating models", hasEnoughParticipatingModels("panel", 2));

check(
  "build mode message asks for one model",
  participatingModelRequirementMessage("build") === "Select at least one participating model.",
  participatingModelRequirementMessage("build")
);
check(
  "panel mode message asks for two models",
  participatingModelRequirementMessage("panel") === "Select at least two participating models.",
  participatingModelRequirementMessage("panel")
);

process.exit(failed === 0 ? 0 : 1);
