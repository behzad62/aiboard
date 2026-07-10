export interface BuildTaskPhaseLike {
  title?: string;
  instructions?: string;
  expectedOutputs?: string;
  testOutputPaths?: string[];
}

export function isRedBuildTask(task: BuildTaskPhaseLike): boolean {
  if ((task.testOutputPaths?.length ?? 0) === 0) return false;
  const text = [task.title, task.instructions, task.expectedOutputs]
    .filter(Boolean)
    .join("\n");
  return (
    /\bRED(?:\s+phase)?\b/i.test(text) &&
    /\b(?:fail|fails|failed|failing|expected failure|before implementation)\b/i.test(
      text
    )
  );
}
