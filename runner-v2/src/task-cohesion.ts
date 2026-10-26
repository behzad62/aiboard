/** Shared semantic guidance; task size is not a line/file/count-based kernel gate. */
export const TASK_COHESION_GUIDELINE = [
  "Plan each implementation task as one coherent, independently reviewable change with a meaningful outcome that can be accepted when its declared dependencies are met.",
  "Keep the implementation, necessary exports/wiring, and targeted tests for that outcome together; keep individual coding actions within the task (the steps field on full contracts), not separate tasks without distinct acceptance boundaries.",
  "Merge fragments that have no independently useful outcome; split unrelated outcomes or work too broad for one focused review. Do not split merely to fill parallel worker slots or fit one model response, file, or method, and impose no arbitrary line/file/task-count limit.",
  "A small fix, independently consumable foundation, bounded investigation, verification, or repair can be a valid task. Its deliverable may be evidence or a decision rather than code, with concrete acceptance and any dependent unlocks.",
].join("\n");

export const TASK_COHESION_REVIEW_INSTRUCTIONS = [
  TASK_COHESION_GUIDELINE,
  "Check task cohesion as well as coverage: report undersized_task when named tasks merely divide one deliverable into coding steps with no distinct acceptance boundary; incoherent_task when a task bundles unrelated outcomes; oversized_task when its scope cannot receive one focused implementation and review.",
  "For each cohesion finding, cite the affected task ids and concrete outcomes, criteria or dependencies, and propose a specific merge or split in the claim with the reason it improves independent acceptance. File count, line count, task count, and the presence of dependencies alone are not defects; do not invent size findings for legitimate small or evidence-only deliverables.",
].join("\n");
