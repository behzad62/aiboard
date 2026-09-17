import type { BenchmarkArtifact, BenchmarkVerifierResult } from "@/lib/benchmark/types";
import {
  parseRecoverableJobServiceDiagnostics,
  type RecoverableJobServiceDiagnostics,
  type RecoverableJobServiceFamilyResult,
  type RecoverableJobServiceGroup,
} from "@/lib/benchmark/workbench/recoverable-job-service/diagnostics";

interface PublicFamilySnapshot {
  id: string;
  group: string;
  expectation: string;
  contract: string;
}

interface PublicContractSnapshot {
  profile: string;
  contractVersion: string;
  suiteVersion: string;
  contractHash: string;
  suiteHash: string;
  families: PublicFamilySnapshot[];
}

export function RecoverableJobServiceSummary({
  attemptId,
  verifier,
  artifacts,
}: {
  attemptId: string;
  verifier: BenchmarkVerifierResult | null | undefined;
  artifacts: BenchmarkArtifact[];
}) {
  const evidence = readEvidence(attemptId, verifier, artifacts);
  if (!evidence) return null;
  if ("error" in evidence) {
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
        <div className="font-medium">Recoverable Job Service evidence unavailable</div>
        <p className="mt-1 text-xs text-muted-foreground">{evidence.error}</p>
      </div>
    );
  }

  const { diagnostics, contract } = evidence;
  const familiesById = new Map(contract.families.map((family) => [family.id, family]));
  const anchorPrefix = `rjs-${encodeAnchor(attemptId)}`;
  return (
    <div className="space-y-4 rounded-md border p-3 text-sm">
      <div>
        <div className="font-medium">Recoverable Job Service evidence</div>
        <p className="mt-1 text-xs text-muted-foreground">
          {diagnostics.status === "valid"
            ? diagnostics.resolved
              ? "Every mandatory family and variant passed with measured safety evidence."
              : "At least one mandatory outcome did not pass. Binary score: 0."
            : diagnostics.error?.message ?? "The trusted evaluation was excluded."}
        </p>
      </div>

      <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Profile" value={diagnostics.profile} />
        <Metric label="Contract" value={diagnostics.contractVersion} />
        <Metric label="Suite" value={diagnostics.suiteVersion} />
        <Metric label="Outcome" value={diagnostics.resolved ? "Resolved" : diagnostics.status.replaceAll("_", " ")} />
        <Metric label="Contract hash" value={diagnostics.contractHash ?? "Unavailable"} mono />
        <Metric label="Suite hash" value={diagnostics.suiteHash ?? "Unavailable"} mono />
        <Metric label="Candidate hash" value={diagnostics.candidateHash} mono />
        <Metric label="Input commitment" value={diagnostics.inputIdentity?.rootCommitment ?? "No accepted replay identity"} mono />
      </dl>

      <section className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Group coverage
        </h4>
        <div className="grid gap-2 sm:grid-cols-5">
          {(["A", "B", "C", "D", "E"] as RecoverableJobServiceGroup[]).map((group) => {
            const row = diagnostics.groups[group];
            return <Metric key={group} label={`Group ${group}`} value={`${row.passed}/${row.total}`} />;
          })}
        </div>
      </section>

      {diagnostics.safetyFailures.length > 0 ? (
        <section className="space-y-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Observed safety failures
          </h4>
          {diagnostics.safetyFailures.map((failure, index) => (
            <div key={`${failure.familyId}:${failure.variantId ?? "family"}:${index}`} className="rounded-md border border-red-500/30 px-3 py-2">
              <div className="font-medium">{failure.familyId}{failure.variantId ? ` · ${failure.variantId}` : ""} · {failure.code}</div>
              <div className="mt-1 text-xs text-muted-foreground">{failure.detail}</div>
            </div>
          ))}
        </section>
      ) : null}

      <section className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Mandatory families
        </h4>
        {diagnostics.families.map((family) => (
          <FamilyEvidence
            key={family.id}
            family={family}
            published={familiesById.get(family.id)}
            anchorPrefix={anchorPrefix}
          />
        ))}
      </section>
    </div>
  );
}

function FamilyEvidence({
  family,
  published,
  anchorPrefix,
}: {
  family: RecoverableJobServiceFamilyResult;
  published?: PublicFamilySnapshot;
  anchorPrefix: string;
}) {
  const clauseId = `${anchorPrefix}-${family.id.toLowerCase()}`;
  return (
    <details className="rounded-md border px-3 py-2" open={!family.passed}>
      <summary className="cursor-pointer list-none">
        <span className="font-medium">{family.id}</span>
        <span className="ml-2 text-xs text-muted-foreground">
          {family.passed ? "Passed" : "Failed"} · {family.safetyChecked ? "Safety measured" : "Safety unmeasured"} · {family.variants.filter((variant) => variant.passed).length}/{family.variants.length} variants
        </span>
      </summary>
      <div className="mt-3 space-y-3 border-t pt-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Observed result</div>
          <p className="mt-1">{family.reason}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Schedule {family.scheduleId} · {family.operations} operations · {family.promiseJobs} promise jobs
          </p>
        </div>
        {published ? (
          <div id={clauseId} className="scroll-mt-20 rounded-md bg-muted/40 px-3 py-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Public expectation · <a className="underline underline-offset-2" href={`#${clauseId}`}>{published.contract}</a>
            </div>
            <p className="mt-1">{published.expectation}</p>
          </div>
        ) : null}
        <EvidenceList title="Family assertions" rows={family.assertions} />
        <details>
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            Variant evidence ({family.variants.length})
          </summary>
          <div className="mt-2 space-y-2">
            {family.variants.map((variant) => (
              <div key={variant.id} className="rounded-md bg-muted/30 px-3 py-2">
                <div className="font-medium">{variant.id}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {variant.passed ? "Passed" : "Failed"} · {variant.safetyChecked ? "Safety measured" : "Safety unmeasured"} · {variant.operations} operations · {variant.promiseJobs} promise jobs
                </div>
                <p className="mt-1">{variant.reason}</p>
                {variant.inputIdentity ? (
                  <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                    Input {variant.inputIdentity.caseCommitment}
                  </div>
                ) : null}
                <EvidenceList title="Assertions" rows={variant.assertions} />
              </div>
            ))}
          </div>
        </details>
      </div>
    </details>
  );
}

function EvidenceList({ title, rows }: { title: string; rows: { label: string; passed: boolean }[] }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <ul className="mt-1 space-y-1 text-xs">
        {rows.map((row, index) => (
          <li key={`${row.label}:${index}`}>{row.passed ? "Pass" : "Fail"} · {row.label}</li>
        ))}
      </ul>
    </div>
  );
}

function Metric({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 rounded-md border px-3 py-2">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-all font-medium ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}

function readEvidence(
  attemptId: string,
  verifier: BenchmarkVerifierResult | null | undefined,
  artifacts: BenchmarkArtifact[]
): { diagnostics: RecoverableJobServiceDiagnostics; contract: PublicContractSnapshot } | { error: string } | null {
  if (!verifier || verifier.attemptId !== attemptId) return null;
  let outer: unknown;
  try {
    outer = JSON.parse(verifier.resultJson) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(outer) || !isRecord(outer.recoverableJobService)) return null;
  const parsed = parseRecoverableJobServiceDiagnostics(outer.recoverableJobService);
  if (!parsed.ok) return { error: parsed.error };
  const artifact = artifacts.find(
    (candidate) => candidate.attemptId === attemptId && candidate.id.endsWith(":rjs-public-contract")
  );
  if (!artifact) return { error: "The recorded public contract snapshot is missing." };
  const contract = parsePublicContract(artifact.content);
  if (!contract) return { error: "The recorded public contract snapshot is malformed." };
  const diagnostics = parsed.value;
  if (
    contract.profile !== diagnostics.profile ||
    contract.contractVersion !== diagnostics.contractVersion ||
    contract.suiteVersion !== diagnostics.suiteVersion ||
    contract.contractHash !== diagnostics.contractHash ||
    contract.suiteHash !== diagnostics.suiteHash
  ) {
    return { error: "The public contract snapshot does not match the recorded verifier identity." };
  }
  return { diagnostics, contract };
}

function parsePublicContract(content: string): PublicContractSnapshot | null {
  try {
    const value = JSON.parse(content) as unknown;
    if (!isRecord(value) || value.benchmark !== "recoverable-job-service" || !Array.isArray(value.families)) return null;
    const families = value.families.filter(isPublicFamily);
    if (families.length !== value.families.length) return null;
    for (const key of ["profile", "contractVersion", "suiteVersion", "contractHash", "suiteHash"] as const) {
      if (typeof value[key] !== "string") return null;
    }
    return { ...value, families } as PublicContractSnapshot;
  } catch {
    return null;
  }
}

function isPublicFamily(value: unknown): value is PublicFamilySnapshot {
  return isRecord(value) && ["id", "group", "expectation", "contract"].every((key) => typeof value[key] === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function encodeAnchor(value: string): string {
  return Array.from(value, (character) => character.codePointAt(0)!.toString(16)).join("-");
}
