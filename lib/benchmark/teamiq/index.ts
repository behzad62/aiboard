export {
  deriveSoloTeamComposition,
  deriveTeamComposition,
  getTeamCompositionModelIds,
  inferProviderId,
  isSoloTeamComposition,
  normalizeTeamRoles,
} from "./compositions";
export type {
  TeamIqCompositionInput,
  TeamIqSoloCompositionInput,
} from "./compositions";

export { linkTeamLiftBaselines } from "./baselines";
export type { TeamIqBaselineInput, TeamIqBaselineLink } from "./baselines";

export { buildTeamIqComboMatrixRows } from "./combo-matrix";
export type {
  TeamIqComboMatrixInput,
  TeamIqComboMatrixRow,
  TeamIqRecommendationLabel,
} from "./combo-matrix";
