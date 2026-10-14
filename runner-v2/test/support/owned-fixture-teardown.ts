/** Test-only owner teardown; no retries, process control or release inference. */
export async function finishOwnedFixture(input: {
  bodyFailed: boolean;
  bodyError?: unknown;
  closers: readonly { name: string; close: () => void | Promise<void> }[];
  remove: () => void;
  report?: (failures: readonly { phase: string; error: unknown }[]) => void | Promise<void>;
}): Promise<void> {
  const failures: { phase: string; error: unknown }[] = input.bodyFailed ? [{ phase: "body", error: input.bodyError }] : [];
  let ownerCloseFailed = false;
  for (const closer of input.closers) {
    try { await closer.close(); }
    catch (error) { ownerCloseFailed = true; failures.push({ phase: closer.name, error }); }
  }
  if (!ownerCloseFailed) {
    try { input.remove(); } catch (error) { failures.push({ phase: "remove", error }); }
  }
  if (failures.length && input.report) {
    try { await input.report(failures); } catch (error) { failures.push({ phase: "report", error }); }
  }
  if (failures.length === 1) throw failures[0]!.error;
  if (failures.length > 1) throw new AggregateError(failures.map((failure) => failure.error),
    "Owned fixture failures in original order: " + failures.map((failure) => failure.phase).join(", "));
}
