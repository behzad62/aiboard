/**
 * Identifies whether a terminal projection came directly from current durable
 * data, was reconstructed from a legacy durable representation, or was not
 * available in that historical Runner state.
 */
export type HistoricalReadProvenance =
  | "durable"
  | "legacy_replay"
  | "unavailable";

export interface HistoricalReadProvenanceBySurface {
  usage: HistoricalReadProvenance;
  transcript: HistoricalReadProvenance;
  evidence: HistoricalReadProvenance;
  memories: HistoricalReadProvenance;
  skills: HistoricalReadProvenance;
  processes: HistoricalReadProvenance;
  capabilities: HistoricalReadProvenance;
  events: HistoricalReadProvenance;
  files: HistoricalReadProvenance;
}
