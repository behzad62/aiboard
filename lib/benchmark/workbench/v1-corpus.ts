import type { BenchmarkCaseV2 } from "@/lib/benchmark/types";
import {
  loadWorkBenchCase,
  toBenchmarkCaseV2,
} from "./case-loader";
import type { WorkBenchCase } from "./types";
import goErrorReturn from "../../../benchmarks/workbench/v1/cases/workbench-v1-go-error-return-0007.json";
import goPositiveSum from "../../../benchmarks/workbench/v1/cases/workbench-v1-go-positive-sum-0006.json";
import pyClamp from "../../../benchmarks/workbench/v1/cases/workbench-v1-py-clamp-0005.json";
import pySlugify from "../../../benchmarks/workbench/v1/cases/workbench-v1-py-slugify-0004.json";
import reactAria from "../../../benchmarks/workbench/v1/cases/workbench-v1-react-aria-0009.json";
import reactStatus from "../../../benchmarks/workbench/v1/cases/workbench-v1-react-status-0010.json";
import rustSaturating from "../../../benchmarks/workbench/v1/cases/workbench-v1-rs-saturating-0008.json";
import tsCsv from "../../../benchmarks/workbench/v1/cases/workbench-v1-ts-csv-0003.json";
import tsLimit from "../../../benchmarks/workbench/v1/cases/workbench-v1-ts-limit-0002.json";
import tsNormalize from "../../../benchmarks/workbench/v1/cases/workbench-v1-ts-normalize-0001.json";

export type WorkBenchFixtureLanguage =
  | "typescript"
  | "python"
  | "go"
  | "rust"
  | "react-ui";

export interface WorkBenchV1CaseOption {
  id: string;
  label: string;
  fixtureLanguage: WorkBenchFixtureLanguage;
  caseHash: string;
  referenceSolutionNotes: string;
  negativeControlWrongSolution: string;
  case: WorkBenchCase;
}

interface WorkBenchV1CaseArtifact {
  fixtureLanguage: WorkBenchFixtureLanguage;
  caseHash: string;
  referenceSolutionNotes: string;
  negativeControlWrongSolution: string;
}

const WORKBENCH_V1_ARTIFACTS = [
  tsNormalize,
  tsLimit,
  tsCsv,
  pySlugify,
  pyClamp,
  goPositiveSum,
  goErrorReturn,
  rustSaturating,
  reactAria,
  reactStatus,
] as const;

export function listWorkBenchV1CaseOptions(): WorkBenchV1CaseOption[] {
  return WORKBENCH_V1_ARTIFACTS.map((artifact) => {
    const loaded = loadWorkBenchCase(artifact);
    const metadata = artifact as WorkBenchV1CaseArtifact;
    return {
      id: loaded.id,
      label: `${loaded.title} (${metadata.fixtureLanguage})`,
      fixtureLanguage: metadata.fixtureLanguage,
      caseHash: metadata.caseHash,
      referenceSolutionNotes: metadata.referenceSolutionNotes,
      negativeControlWrongSolution: metadata.negativeControlWrongSolution,
      case: loaded,
    };
  });
}

export function getWorkBenchV1CaseOption(
  id: string
): WorkBenchV1CaseOption | null {
  return listWorkBenchV1CaseOptions().find((item) => item.id === id) ?? null;
}

export function workBenchCaseToBenchmarkCaseV2(
  option: WorkBenchV1CaseOption,
  timestamp?: string
): BenchmarkCaseV2 {
  return toBenchmarkCaseV2(option.case, timestamp);
}
