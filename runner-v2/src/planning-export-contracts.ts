/** Observational, redacted references. Never use these display IDs as authority. */
export interface PlanningExportReference {
  method: "GET";
  path: string;
  /** JSON Pointer into the authenticated build projection. */
  selector: string;
  unavailableReason?: string;
}
export interface PlanningReferenceExport {
  version: 1;
  categories: { id: string; title: string; reference: PlanningExportReference; recordCount: number; omittedCount: number; items: { id: string; reference: PlanningExportReference; text: string; truncated: boolean }[] }[];
  cards: { id: string; kind: "worker" | "controller" | "resume_planning"; reference: PlanningExportReference; text: string }[];
  omittedCardCount: number;
  nativeLaunch: { status: "not_applicable"; rationale: string };
}
