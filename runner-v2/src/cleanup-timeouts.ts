// Shared bounded deadline for authorized streaming/managed cleanup.
// Callers may choose a longer outer deadline, but no production joiner or
// physical stop layer may silently shorten an in-flight authorized cleanup.
export const AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS = 60_000;

// A Windows Job host start's ceiling: for a host that stays alive and silent, never the expected time (the launch ends
// at once when its supervisor reports, or exits). windows-job-process-host.ts has the measured starts it is set from.
export const WINDOWS_JOB_START_CEILING_MS = 120_000;
// How long a launcher's abort wait may extend while its supervisor ends an Assign-path root (status rootEnding): the
// supervisor's own bounds for that (managed-process-supervisor.mjs ROOT_ENDER_START_CEILING_MS 120 s plus
// ROOT_ENDER_ACTION_CEILING_MS 60 s) and a margin, so that a supervisor still ending the root is not killed first.
export const ROOT_ENDING_CEILING_MS = 190_000;
// A managed start's own ceiling, for phases that outlast every lower bound. The backend bounds its own launch (the Job
// host: its start ceiling, then its abort, which extends while an Assign-path root is ended), and a launch the backend
// ends itself fails naming its exact record, which then settles on the supervisor's proof. A cut by this ceiling would
// instead cancel the launch while it is still pending. So the ceiling sits above the backend's whole bounded launch,
// with a margin for the phases around it (isolation, channel), and a managed start follows the backend's progress: it
// returns as soon as the backend does. The former fixed 30 s cut real cold starts (32.9 s measured, about 75-85 s on a
// slower host).
export const MANAGED_START_CEILING_MS = WINDOWS_JOB_START_CEILING_MS + ROOT_ENDING_CEILING_MS + 30_000;
