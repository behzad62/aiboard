import type {
  BenchmarkArtifact,
  BenchmarkAttemptV2,
  BenchmarkFailure,
  BenchmarkModelCallTrace,
  BenchmarkRunEvent,
  BenchmarkToolCallTrace,
  BenchmarkTrack,
  BenchmarkVerifierResult,
  HarnessProfile,
} from "@/lib/benchmark/types";

export interface CertifiedRunBudget {
  maxUsd?: number;
  maxModelCalls?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxWallClockMs?: number;
}

export interface CertifiedRunContext {
  runId: string;
  mode: "certified";
  track: BenchmarkTrack;
  harnessProfile: HarnessProfile;
  suiteId: string;
  startedAt: string;
  caseIds: string[];
  teamCompositionIds: string[];
  modelBudget: CertifiedRunBudget;
  recordAttempt(attempt: BenchmarkAttemptV2): Promise<void>;
  recordVerifier(result: BenchmarkVerifierResult): Promise<void>;
  recordArtifact(artifact: BenchmarkArtifact): Promise<void>;
  recordTrace(trace: BenchmarkModelCallTrace): Promise<void>;
  recordEvent(event: BenchmarkRunEvent): Promise<void>;
  recordToolCall(trace: BenchmarkToolCallTrace): Promise<void>;
  recordFailure(failure: BenchmarkFailure): Promise<void>;
}

export interface CertifiedRunPersistenceSnapshot {
  attempts: BenchmarkAttemptV2[];
  verifierResults: BenchmarkVerifierResult[];
  artifacts: BenchmarkArtifact[];
  traces: BenchmarkModelCallTrace[];
  events: BenchmarkRunEvent[];
  toolCalls: BenchmarkToolCallTrace[];
  failures: BenchmarkFailure[];
}

export interface PersistentCertifiedRunContext extends CertifiedRunContext {
  snapshot(): CertifiedRunPersistenceSnapshot;
}
