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
export { buildTeamIqRecommendationCards } from "./recommendations";
export type {
  TeamIqRecommendationCard,
  TeamIqRecommendationCardKind,
} from "./recommendations";

export { planTeamIqExperiment, TEAM_IQ_STRATEGIES } from "./experiment-planner";
export type { PlanTeamIqExperimentInput } from "./experiment-planner";

export { runCertifiedTeamIq } from "./certified-runner";
export type {
  RunCertifiedTeamIqInput,
  TeamIqCertifiedTask,
} from "./certified-runner";

export { createTeamIqCompositionFromSelection } from "./ui-selection";
export type { CreateTeamIqCompositionSelectionInput } from "./ui-selection";
