import {
  listBenchmarkCaseV2,
  listBenchmarkTeamCompositions,
} from "@/lib/benchmark/store";
import type {
  BenchmarkCaseV2,
  BenchmarkTeamComposition,
  BenchmarkTrack,
  HarnessCertificationResult,
} from "@/lib/benchmark/types";
import { assertHarnessCertificationCanRun } from "./certification";

export interface CertifiedRunSelectionInput {
  track: BenchmarkTrack;
  caseIds: string[];
  teamCompositionIds: string[];
}

export interface CertifiedRunSelection {
  cases: BenchmarkCaseV2[];
  teamCompositions: BenchmarkTeamComposition[];
}

export function assertCertifiedHarnessCanRun(
  certification: HarnessCertificationResult
): void {
  assertHarnessCertificationCanRun(certification);
}

export async function loadAndValidateCertifiedRunSelection(
  input: CertifiedRunSelectionInput
): Promise<CertifiedRunSelection> {
  const [allCases, allTeams] = await Promise.all([
    listBenchmarkCaseV2(),
    listBenchmarkTeamCompositions(),
  ]);
  return validateCertifiedRunSelection({
    ...input,
    cases: allCases,
    teamCompositions: allTeams,
  });
}

export function validateCertifiedRunSelection(input: CertifiedRunSelectionInput & {
  cases: BenchmarkCaseV2[];
  teamCompositions: BenchmarkTeamComposition[];
}): CertifiedRunSelection {
  if (input.caseIds.length === 0) {
    throw new Error("Certified run requires at least one case.");
  }
  if (input.teamCompositionIds.length === 0) {
    throw new Error("Certified run requires at least one team composition.");
  }

  const caseById = new Map(input.cases.map((item) => [item.id, item]));
  const teamById = new Map(input.teamCompositions.map((item) => [item.id, item]));
  const selectedCases = input.caseIds.map((id) => {
    const found = caseById.get(id);
    if (!found) throw new Error(`Missing certified case: ${id}`);
    if (found.track !== input.track) {
      throw new Error(`Certified case ${id} uses track ${found.track}, expected ${input.track}.`);
    }
    return found;
  });
  const selectedTeams = input.teamCompositionIds.map((id) => {
    const found = teamById.get(id);
    if (!found) throw new Error(`Missing team composition: ${id}`);
    return found;
  });

  return { cases: selectedCases, teamCompositions: selectedTeams };
}
