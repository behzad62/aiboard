import type { BuildVerificationSummary } from "@/lib/client/discussion-live-state";

/** "2 of 3 checks passed", or what a verification with no counted check says instead. */
export function verificationPassedText(summary: BuildVerificationSummary): string {
  if (summary.total === 0) return "No final-verification check ran.";
  return `${summary.passed} of ${summary.total} final-verification check${summary.total === 1 ? "" : "s"} passed.`;
}

/**
 * VF8: how many final-verification checks passed and each thing the Build did not verify (a
 * missing tool, a skip, a known defect, an Architect override, an item left for the owner).
 */
export function VerificationSummary({ summary, className }: { summary: BuildVerificationSummary; className?: string }) {
  return (
    <div aria-label="Verification summary" className={className}>
      <p className="font-medium">{verificationPassedText(summary)}</p>
      {summary.notVerified.length > 0 ? (
        <>
          <p className="mt-1.5 font-medium">Not verified ({summary.notVerified.length}):</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {summary.notVerified.map((item) => (
              <li key={item.key}>
                {item.label}
                <span className="block text-xs text-muted-foreground">{item.reason}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">Nothing was left unverified.</p>
      )}
    </div>
  );
}
