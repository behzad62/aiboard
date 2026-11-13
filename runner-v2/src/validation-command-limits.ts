/**
 * Bounds shared by aiboard-validation.json commands (project-validation-config.ts) and the
 * verification plan's suggested checks (verification-plan-v2.ts). They live here so the plan
 * module can read them without importing the config module, which imports the plan module
 * to parse a version-2 file's `checks`.
 */
export const MAX_TIER_ARG_COUNT = 100;
export const MAX_TIER_TIMEOUT_MS = 1_800_000;
export const MAX_TIER_ENV_VARS = 100;
export const MAX_TIER_ENV_VALUE_LENGTH = 4000;
/** An environment variable name a command may set. */
export const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
