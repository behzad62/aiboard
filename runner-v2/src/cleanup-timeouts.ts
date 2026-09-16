// Shared bounded deadline for authorized streaming/managed cleanup.
// Callers may choose a longer outer deadline, but no production joiner or
// physical stop layer may silently shorten an in-flight authorized cleanup.
export const AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS = 60_000;
