import {
  createModelCallTrace,
  type CreateModelCallTraceInput,
} from "@/lib/benchmark/model-call-traces";
import type { BenchmarkModelCallTrace } from "@/lib/benchmark/types";
import type { CertifiedRunContext } from "./run-context";

export type CreateCertifiedModelCallTraceInput = CreateModelCallTraceInput;

export function createCertifiedModelCallTrace(
  input: CreateCertifiedModelCallTraceInput
): BenchmarkModelCallTrace {
  return createModelCallTrace(input);
}

export async function recordCertifiedModelCallTrace(
  context: CertifiedRunContext,
  trace: BenchmarkModelCallTrace
): Promise<string> {
  await context.recordTrace(trace);
  return trace.id;
}
