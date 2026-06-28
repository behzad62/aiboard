import type {
  BenchmarkAttemptV2,
  BenchmarkFailure,
  CertifiedAttemptStatus,
} from "@/lib/benchmark/types";
import {
  classifyBenchmarkFailure,
  explainCertifiedFailureStatus,
  isInvalidCertifiedRun,
  type CertifiedFailureClassification,
} from "./classify-failure";

export interface CertifiedRunResultClassification {
  status: CertifiedAttemptStatus;
  passed: boolean;
  invalidRun: boolean;
  modelAccountable: boolean;
  missingFailureRecord: boolean;
  classifications: CertifiedFailureClassification[];
  explanation: string;
}

export function classifyCertifiedRunResult(input: {
  attempt: Pick<BenchmarkAttemptV2, "status" | "failureIds">;
  failures: Array<Pick<BenchmarkFailure, "id" | "code" | "source" | "message" | "details">>;
}): CertifiedRunResultClassification {
  const linkedFailures = input.failures.filter((failure) =>
    input.attempt.failureIds.includes(failure.id)
  );
  const classifications = linkedFailures.map((failure) =>
    classifyBenchmarkFailure(failure)
  );
  const passed = input.attempt.status === "passed";
  const invalidRun =
    isInvalidCertifiedRun(input.attempt.status) ||
    classifications.some((classification) => classification.invalidRun);
  const modelAccountable =
    !passed &&
    !invalidRun &&
    (classifications.length === 0 ||
      classifications.some((classification) => classification.modelAccountable));

  return {
    status: input.attempt.status,
    passed,
    invalidRun,
    modelAccountable,
    missingFailureRecord: !passed && linkedFailures.length === 0,
    classifications,
    explanation: explainCertifiedFailureStatus(input.attempt.status),
  };
}
