import { createHash } from "node:crypto";

export interface DefectClassRecord {
  readonly projectId: string;
  readonly classId: string;
  readonly label: string;
  readonly count: number;
}

export interface ModelReviewOutcomeRecord {
  readonly projectId: string;
  readonly runId?: string;
  readonly modelId: string;
  readonly taskId: string;
  readonly accepted: boolean;
  readonly defectFound: boolean;
  readonly recordedAt: string;
}

export interface RecordedDefectFinding {
  readonly projectId: string;
  readonly label: string;
  readonly taskId: string;
  readonly reviewId: string;
  readonly findingId: string;
  readonly recordedAt: string;
}

export interface DefectFindingRecorder {
  recordDefectFinding(input: RecordedDefectFinding): void;
}

export interface ReviewDefectRecorder {
  readonly projectId: string;
  readonly store: DefectFindingRecorder;
  /** T6b repair (EP50): per-model review outcomes for the track-record snapshot. */
  readonly modelOutcomes?: (projectId: string, runId?: string) => ModelReviewOutcomeRecord[];
}

export function normalizeDefectClass(input: string): string {
  const label = input.trim().replace(/\s+/g, " ");
  if (!label) throw new Error("Review findings require a short defect class.");
  return label;
}

export function defectClassId(projectId: string, label: string): string {
  return `defect:${createHash("sha256").update(`${projectId}\0${normalizeDefectClass(label).toLowerCase()}`).digest("hex").slice(0, 20)}`;
}

export function topDefectClasses(records: readonly DefectClassRecord[], limit = 5): string[] {
  return [...records].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)).slice(0, limit).map((record) => record.label);
}

export function modelRiskSnapshot(records: readonly ModelReviewOutcomeRecord[], modelId: string): {
  readonly reviewedTasks: number;
  readonly defectTasks: number;
  readonly defaultTierUsed: boolean;
} {
  const model = records.filter((record) => record.modelId === modelId);
  return { reviewedTasks: model.length, defectTasks: model.filter((record) => record.defectFound).length, defaultTierUsed: model.length === 0 };
}

/**
 * T6b repair (B7/EP50): the OA-16 track-record snapshot for the T5
 * change-risk author tier. One row per (run, task, model) already aggregates
 * earlier rounds without erasing them (defect_found is sticky), so grouping
 * rows by model is the honest per-model history.
 */
export function modelTrackRecordSnapshot(records: readonly ModelReviewOutcomeRecord[]): {
  readonly records: Readonly<Record<string, { readonly tasksReviewed: number; readonly defectsFound: number }>>;
  readonly snapshotId: string;
} {
  const byModel = new Map<string, { tasksReviewed: number; defectsFound: number }>();
  for (const record of records) {
    const entry = byModel.get(record.modelId) ?? { tasksReviewed: 0, defectsFound: 0 };
    entry.tasksReviewed += 1;
    if (record.defectFound) entry.defectsFound += 1;
    byModel.set(record.modelId, entry);
  }
  const sorted = [...byModel.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    records: Object.fromEntries(sorted),
    snapshotId: `track:${createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16)}`,
  };
}
