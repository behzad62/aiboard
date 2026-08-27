export type BuildRiskLevel = "low" | "high";

export type BuildRiskReasonCode =
  | "architect_declared_high"
  | "stricter_qualification"
  | "destructive_effect"
  | "credential_effect"
  | "external_write_effect"
  | "integration_conflict"
  | "security_auth_crypto_path"
  | "migration_schema_data_path"
  | "dependency_lockfile"
  | "ci_deployment_infrastructure_path";

export interface BuildRiskKernelFacts {
  readonly destructiveEffects: boolean;
  readonly credentialEffects: boolean;
  readonly externalWriteEffects: boolean;
  readonly integrationConflict: boolean;
  readonly changedPaths: readonly string[];
}

export interface BuildRiskAssessmentInput {
  readonly architectDeclaration: BuildRiskLevel;
  readonly stricterQualification: boolean;
  readonly kernelFacts: BuildRiskKernelFacts;
}

export interface BuildRiskReason {
  readonly code: BuildRiskReasonCode;
  readonly evidence: readonly string[];
}

export interface BuildRiskAssessment {
  readonly risk: BuildRiskLevel;
  readonly reasons: readonly BuildRiskReason[];
  readonly normalizedChangedPaths: readonly string[];
}

const DEPENDENCY_LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "deno.lock",
  "flake.lock",
  "gemfile.lock",
  "go.sum",
  "mix.lock",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.resolved",
  "packages.lock.json",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "podfile.lock",
  "pubspec.lock",
  "uv.lock",
  "yarn.lock",
]);

const INFRASTRUCTURE_FILES = new Set([
  ".gitlab-ci.yml",
  ".gitlab-ci.yaml",
  "appveyor.yml",
  "appveyor.yaml",
  "azure-pipelines.yml",
  "azure-pipelines.yaml",
  "bitbucket-pipelines.yml",
  "bitbucket-pipelines.yaml",
  "cdk.json",
  "chart.yaml",
  "chart.yml",
  "cloudbuild.yml",
  "cloudbuild.yaml",
  "compose.yml",
  "compose.yaml",
  "deployment.yaml",
  "deployment.yml",
  "docker-compose.yml",
  "docker-compose.yaml",
  "fly.toml",
  "jenkinsfile",
  "kustomization.yaml",
  "kustomization.yml",
  "netlify.toml",
  "pulumi.yaml",
  "pulumi.yml",
  "serverless.yaml",
  "serverless.yml",
  "vercel.json",
  "wrangler.toml",
]);

const SECURITY_TOKENS = new Set([
  "auth",
  "authentication",
  "authorization",
  "authorize",
  "cipher",
  "credential",
  "credentials",
  "crypto",
  "cryptographic",
  "cryptography",
  "decrypt",
  "decryption",
  "encrypt",
  "encrypted",
  "encryption",
  "keyring",
  "oauth",
  "oidc",
  "rbac",
  "secret",
  "secrets",
  "security",
  "signature",
  "signing",
]);

const DATA_DIRECTORY_TOKENS = new Set([
  "data",
  "database",
  "databases",
  "db",
  "migration",
  "migrations",
  "schema",
  "schemas",
]);

const DATA_FILENAME_TOKENS = new Set([
  "database",
  "db",
  "migration",
  "migrations",
  "schema",
  "schemas",
]);

const INFRASTRUCTURE_DIRECTORY_TOKENS = new Set([
  "ci",
  "deploy",
  "deployment",
  "helm",
  "infra",
  "infrastructure",
  "k8s",
  "kubernetes",
  "pulumi",
  "terraform",
]);

const INFRASTRUCTURE_FILENAME_TOKENS = new Set([
  ...INFRASTRUCTURE_DIRECTORY_TOKENS,
  "workflow",
  "workflows",
]);

export function assessBuildRisk(input: BuildRiskAssessmentInput): BuildRiskAssessment {
  const normalizedChangedPaths = normalizeChangedPaths(input.kernelFacts.changedPaths);
  const reasons: BuildRiskReason[] = [];
  const add = (code: BuildRiskReasonCode, evidence: readonly string[]) => {
    if (evidence.length === 0) return;
    reasons.push(Object.freeze({
      code,
      evidence: Object.freeze([...new Set(evidence)].sort()),
    }));
  };

  if (input.architectDeclaration === "high") {
    add("architect_declared_high", ["architect:high"]);
  }
  if (input.stricterQualification) {
    add("stricter_qualification", ["qualification:strict"]);
  }
  if (input.kernelFacts.destructiveEffects) {
    add("destructive_effect", ["kernel:destructive_effect"]);
  }
  if (input.kernelFacts.credentialEffects) {
    add("credential_effect", ["kernel:credential_effect"]);
  }
  if (input.kernelFacts.externalWriteEffects) {
    add("external_write_effect", ["kernel:external_write_effect"]);
  }
  if (input.kernelFacts.integrationConflict) {
    add("integration_conflict", ["kernel:integration_conflict"]);
  }

  add(
    "security_auth_crypto_path",
    normalizedChangedPaths.filter(isSecurityPath),
  );
  add(
    "migration_schema_data_path",
    normalizedChangedPaths.filter(isMigrationSchemaDataPath),
  );
  add(
    "dependency_lockfile",
    normalizedChangedPaths.filter(isDependencyLockfile),
  );
  add(
    "ci_deployment_infrastructure_path",
    normalizedChangedPaths.filter(isCiDeploymentInfrastructurePath),
  );

  return Object.freeze({
    risk: reasons.length > 0 ? "high" : "low",
    reasons: Object.freeze(reasons),
    normalizedChangedPaths,
  });
}

function normalizeChangedPaths(paths: readonly string[]): readonly string[] {
  const normalized = paths
    .map(normalizePath)
    .filter((path) => path.length > 0);
  return Object.freeze([...new Set(normalized)].sort());
}

function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.trim().replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") {
      segments.pop();
      continue;
    }
    segments.push(segment.toLowerCase());
  }
  return segments.join("/");
}

function isSecurityPath(path: string): boolean {
  const segments = path.split("/");
  return segments.some((segment) =>
    SECURITY_TOKENS.has(segment) ||
    filenameTokens(segment).some((token) => SECURITY_TOKENS.has(token))
  );
}

function isMigrationSchemaDataPath(path: string): boolean {
  const segments = path.split("/");
  return segments.some((segment, index) => {
    const isFilename = index === segments.length - 1;
    if (!isFilename) return DATA_DIRECTORY_TOKENS.has(segment);
    if (DATA_DIRECTORY_TOKENS.has(stripExtension(segment))) return true;
    return filenameTokens(segment).some((token) => DATA_FILENAME_TOKENS.has(token));
  });
}

function isDependencyLockfile(path: string): boolean {
  return DEPENDENCY_LOCKFILES.has(path.split("/").at(-1) ?? "");
}

function isCiDeploymentInfrastructurePath(path: string): boolean {
  const segments = path.split("/");
  const filename = segments.at(-1) ?? "";
  if (
    path.startsWith(".github/workflows/") ||
    path.startsWith(".github/actions/")
  ) return true;
  if (
    INFRASTRUCTURE_FILES.has(filename) ||
    /^dockerfile(?:\..+)?$/.test(filename) ||
    /\.(?:tf|tfvars)$/.test(filename)
  ) {
    return true;
  }
  if (filenameTokens(filename).some((token) => INFRASTRUCTURE_FILENAME_TOKENS.has(token))) {
    return true;
  }
  return segments.slice(0, -1).some((segment) =>
    INFRASTRUCTURE_DIRECTORY_TOKENS.has(segment)
  );
}

function filenameTokens(filename: string): string[] {
  return stripExtension(filename).split(/[._-]+/).filter(Boolean);
}

function stripExtension(filename: string): string {
  const extensionIndex = filename.lastIndexOf(".");
  return extensionIndex <= 0 ? filename : filename.slice(0, extensionIndex);
}
