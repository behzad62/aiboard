/**
 * R4/R2 (docs/runner-v2/codex-windows-job-escape-2026-11-18.md): the Runner codes of a launch the Windows Job host
 * refused before CreateProcess, so nothing started: the desktop app policy could not be given to the root, or the
 * Job's membership messages could not be watched.
 */
export const WINDOWS_JOB_LAUNCH_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "windows_job_desktop_policy_unavailable",
  "windows_job_membership_watch_unavailable",
]);

/** The coded refusal anywhere in an error's cause chain (bounded), so a caller can report its code and words. */
export function windowsJobLaunchRefusal(error: unknown): { readonly code: string; readonly message: string } | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && WINDOWS_JOB_LAUNCH_REFUSAL_CODES.has(code)) return { code, message: current.message };
    current = current.cause;
  }
  return undefined;
}
