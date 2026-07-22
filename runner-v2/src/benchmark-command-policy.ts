export interface CommandInvocationInput {
  command?: string;
  args?: readonly string[];
  script?: string;
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
  const rendered = renderedBenchmarkCommand(input);
  return allowedCommands.some((allowed) => allowed.trim() === rendered);
}
