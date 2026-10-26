export interface CommandInvocationInput {
  command?: string;
  args?: readonly string[];
  script?: string;
  env?: Readonly<Record<string, string>>;
}

export function renderedBenchmarkCommand(input: CommandInvocationInput): string {
  if (typeof input.script === "string") return input.script.trim();
  return [input.command ?? "", ...(input.args ?? [])]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
}

export function isBenchmarkCommandAllowed(
  input: CommandInvocationInput,
  allowedCommands: readonly string[] | undefined
): boolean {
  if (allowedCommands === undefined) return true;
  // A fixed public command must not preload a hidden evaluator through NODE_OPTIONS,
  // PYTHONPATH, or another caller-supplied environment override.
  if (input.env && Object.keys(input.env).length > 0) return false;
  const rendered = renderedBenchmarkCommand(input);
  return allowedCommands.some((allowed) => allowed.trim() === rendered);
}
