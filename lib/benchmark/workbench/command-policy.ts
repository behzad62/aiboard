export interface CertifiedBenchmarkCommandPolicy {
  allowedCommands?: string[];
  [key: string]: unknown;
}

export function validateBuildBenchmarkCommand(
  command: string,
  benchmark: CertifiedBenchmarkCommandPolicy | undefined
): { allowed: boolean; reason?: string } {
  if (!benchmark) return { allowed: true };
  const trimmed = command.trim();
  const allowedCommands = benchmark.allowedCommands?.map((item) => item.trim());
  if (allowedCommands && !allowedCommands.includes(trimmed)) {
    return {
      allowed: false,
      reason: `Command is not in the certified benchmark allowlist: ${trimmed}`,
    };
  }
  return { allowed: true };
}
