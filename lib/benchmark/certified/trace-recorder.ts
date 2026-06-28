import {
  createGameModelCallTrace,
  type CreateGameModelCallTraceInput,
} from "@/lib/benchmark/model-call-traces";
import type { BenchmarkModelCallTrace } from "@/lib/benchmark/types";
import type { CertifiedRunContext } from "./run-context";

export type CreateCertifiedModelCallTraceInput = CreateGameModelCallTraceInput;

export function createCertifiedModelCallTrace(
  input: CreateCertifiedModelCallTraceInput
): BenchmarkModelCallTrace {
  return createGameModelCallTrace(input);
}

export async function recordCertifiedModelCallTrace(
  context: CertifiedRunContext,
  trace: BenchmarkModelCallTrace
): Promise<string> {
  await context.recordTrace(trace);
  return trace.id;
}
