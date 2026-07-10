export interface BuildTaskPhaseLike {
  title?: string;
  instructions?: string;
  implementationContract?: string;
  requiredEvidence?: string[];
  expectedOutputs?: string;
  outputPaths?: string[];
  testOutputPaths?: string[];
}

export function isRedBuildTask(task: BuildTaskPhaseLike): boolean {
  if ((task.testOutputPaths?.length ?? 0) === 0) return false;
  const testPaths = new Set(
    (task.testOutputPaths ?? []).map((path) =>
      path.trim().replace(/\\/g, "/").toLowerCase()
    )
  );
  const outputPaths = (task.outputPaths ?? []).map((path) =>
    path.trim().replace(/\\/g, "/").toLowerCase()
  );
  if (outputPaths.some((path) => !testPaths.has(path))) return false;
  const text = [
    task.title,
    task.instructions,
    task.implementationContract,
    ...(task.requiredEvidence ?? []),
    task.expectedOutputs,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    /\bRED\b/.test(text) &&
    /\b(?:fail|fails|failed|failing|expected failure|unexpectedly pass(?:es|ed)?|before(?:\s+\w+){0,4}\s+implementation)\b/i.test(text)
  );
}
