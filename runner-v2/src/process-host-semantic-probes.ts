export type ProcessHostSemanticFact = "unavailable" | "partial" | "verified";

export interface ProcessHostSemanticProbeSource {
  portableDuplex(): Promise<boolean | "partial">;
  windowsBatchArgv(): Promise<boolean | "partial">;
  exactTreeBirth(): Promise<boolean | "partial">;
  /** This operation must actually create and close a Job Object. */
  activeJobCreateClose(): Promise<boolean | "partial">;
}

export interface ProcessHostSemanticFacts {
  readonly portableDuplex: ProcessHostSemanticFact;
  readonly windowsBatchArgv: ProcessHostSemanticFact;
  readonly exactTreeBirth: ProcessHostSemanticFact;
  readonly jobContainment: ProcessHostSemanticFact;
}

export async function probeProcessHostSemantics(
  source: ProcessHostSemanticProbeSource,
): Promise<ProcessHostSemanticFacts> {
  // Probe every semantic independently. In particular, a failed Job probe must
  // not erase portable or batch capabilities that were separately attested.
  const [portableDuplex, windowsBatchArgv, exactTreeBirth, jobContainment] =
    await Promise.all([
      settle(source.portableDuplex),
      settle(source.windowsBatchArgv),
      settle(source.exactTreeBirth),
      settle(source.activeJobCreateClose),
    ]);
  return Object.freeze({
    portableDuplex,
    windowsBatchArgv,
    exactTreeBirth,
    jobContainment,
  });
}

async function settle(
  probe: () => Promise<boolean | "partial">,
): Promise<ProcessHostSemanticFact> {
  try {
    const result = await probe();
    return result === true ? "verified" : result === "partial" ? "partial" : "unavailable";
  } catch {
    return "unavailable";
  }
}
