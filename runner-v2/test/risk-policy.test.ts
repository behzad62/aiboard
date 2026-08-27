import assert from "node:assert/strict";
import test from "node:test";

import {
  assessBuildRisk,
  type BuildRiskAssessmentInput,
  type BuildRiskReasonCode,
} from "../src/risk-policy.js";

const LOW_RISK_INPUT: BuildRiskAssessmentInput = {
  architectDeclaration: "low",
  stricterQualification: false,
  kernelFacts: {
    destructiveEffects: false,
    credentialEffects: false,
    externalWriteEffects: false,
    integrationConflict: false,
    changedPaths: [],
  },
};

test("ordinary workspace changes remain low risk", () => {
  const assessment = assessBuildRisk({
    ...LOW_RISK_INPUT,
    kernelFacts: {
      ...LOW_RISK_INPUT.kernelFacts,
      changedPaths: [
        "src/components/AuthorCard.tsx",
        "src/cryptocurrency-chart.ts",
        "src/circle-layout.ts",
        "src/information-panel.ts",
        "package.json",
        "data-model-notes.txt",
      ],
    },
  });

  assert.deepEqual(assessment, {
    risk: "low",
    reasons: [],
    normalizedChangedPaths: [
      "data-model-notes.txt",
      "package.json",
      "src/circle-layout.ts",
      "src/components/authorcard.tsx",
      "src/cryptocurrency-chart.ts",
      "src/information-panel.ts",
    ],
  });
});

test("Architect and explicit qualification policy can only raise risk", () => {
  assert.deepEqual(reasonCodes(assessBuildRisk({
    ...LOW_RISK_INPUT,
    architectDeclaration: "high",
  })), ["architect_declared_high"]);
  assert.deepEqual(reasonCodes(assessBuildRisk({
    ...LOW_RISK_INPUT,
    stricterQualification: true,
  })), ["stricter_qualification"]);

  const kernelRaised = assessBuildRisk({
    ...LOW_RISK_INPUT,
    architectDeclaration: "low",
    kernelFacts: { ...LOW_RISK_INPUT.kernelFacts, credentialEffects: true },
  });
  assert.equal(kernelRaised.risk, "high");
  assert.deepEqual(reasonCodes(kernelRaised), ["credential_effect"]);
});

test("kernel effect and conflict facts independently require high risk", () => {
  const cases: Array<{
    field: "destructiveEffects" | "credentialEffects" | "externalWriteEffects" | "integrationConflict";
    reason: BuildRiskReasonCode;
  }> = [
    { field: "destructiveEffects", reason: "destructive_effect" },
    { field: "credentialEffects", reason: "credential_effect" },
    { field: "externalWriteEffects", reason: "external_write_effect" },
    { field: "integrationConflict", reason: "integration_conflict" },
  ];

  for (const { field, reason } of cases) {
    const assessment = assessBuildRisk({
      ...LOW_RISK_INPUT,
      kernelFacts: { ...LOW_RISK_INPUT.kernelFacts, [field]: true },
    });
    assert.equal(assessment.risk, "high", field);
    assert.deepEqual(reasonCodes(assessment), [reason], field);
    assert.deepEqual(assessment.reasons[0]?.evidence, [`kernel:${reason}`], field);
  }
});

test("representative sensitive paths map to stable high-risk reason codes", () => {
  const cases: Array<{ path: string; reason: BuildRiskReasonCode }> = [
    { path: "src/auth/session.ts", reason: "security_auth_crypto_path" },
    { path: "src/Authentication.ts", reason: "security_auth_crypto_path" },
    { path: "src/user.auth.ts", reason: "security_auth_crypto_path" },
    { path: "lib/crypto-box.ts", reason: "security_auth_crypto_path" },
    { path: "services/cryptography/keys.ts", reason: "security_auth_crypto_path" },
    { path: "src/cryptographic-signature.ts", reason: "security_auth_crypto_path" },
    { path: "src/authorization/policy.ts", reason: "security_auth_crypto_path" },
    { path: "src/oauth.ts", reason: "security_auth_crypto_path" },
    { path: "src/oidc/client.ts", reason: "security_auth_crypto_path" },
    { path: "src/rbac/roles.ts", reason: "security_auth_crypto_path" },
    { path: "src/encryption/cipher.ts", reason: "security_auth_crypto_path" },
    { path: "security/policy.json", reason: "security_auth_crypto_path" },
    { path: "db/migrations/001_add_user.sql", reason: "migration_schema_data_path" },
    { path: "src/user-schema.ts", reason: "migration_schema_data_path" },
    { path: "src/user.schema.ts", reason: "migration_schema_data_path" },
    { path: "data/seed.json", reason: "migration_schema_data_path" },
    { path: "package-lock.json", reason: "dependency_lockfile" },
    { path: "nested/pnpm-lock.yaml", reason: "dependency_lockfile" },
    { path: "yarn.lock", reason: "dependency_lockfile" },
    { path: "native/Cargo.lock", reason: "dependency_lockfile" },
    { path: "python/poetry.lock", reason: "dependency_lockfile" },
    { path: "elixir/mix.lock", reason: "dependency_lockfile" },
    { path: "dart/pubspec.lock", reason: "dependency_lockfile" },
    { path: "ios/Podfile.lock", reason: "dependency_lockfile" },
    { path: "nix/flake.lock", reason: "dependency_lockfile" },
    { path: "swift/Package.resolved", reason: "dependency_lockfile" },
    { path: "dotnet/packages.lock.json", reason: "dependency_lockfile" },
    { path: "go.sum", reason: "dependency_lockfile" },
    { path: ".github/workflows/release.yml", reason: "ci_deployment_infrastructure_path" },
    { path: ".github/actions/release/action.yml", reason: "ci_deployment_infrastructure_path" },
    { path: ".gitlab-ci.yml", reason: "ci_deployment_infrastructure_path" },
    { path: "infra/main.tf", reason: "ci_deployment_infrastructure_path" },
    { path: "main.tf", reason: "ci_deployment_infrastructure_path" },
    { path: "Pulumi.yaml", reason: "ci_deployment_infrastructure_path" },
    { path: "serverless.yml", reason: "ci_deployment_infrastructure_path" },
    { path: "wrangler.toml", reason: "ci_deployment_infrastructure_path" },
    { path: "deployment.yaml", reason: "ci_deployment_infrastructure_path" },
    { path: "scripts/deployment.ts", reason: "ci_deployment_infrastructure_path" },
    { path: "helm/Chart.yaml", reason: "ci_deployment_infrastructure_path" },
    { path: "deploy/app.yaml", reason: "ci_deployment_infrastructure_path" },
    { path: "Dockerfile", reason: "ci_deployment_infrastructure_path" },
  ];

  for (const entry of cases) {
    const assessment = assessBuildRisk({
      ...LOW_RISK_INPUT,
      kernelFacts: { ...LOW_RISK_INPUT.kernelFacts, changedPaths: [entry.path] },
    });
    assert.equal(assessment.risk, "high", entry.path);
    assert.deepEqual(reasonCodes(assessment), [entry.reason], entry.path);
    assert.deepEqual(assessment.reasons[0]?.evidence, [normalizeExpected(entry.path)], entry.path);
  }
});

test("normalization, deduplication, and reason ordering are deterministic", () => {
  const paths = [
    ".\\SRC\\AUTH\\session.ts",
    "src//auth/./session.ts",
    "./package-lock.json",
    ".github\\workflows\\ci.yml",
    "db/schema.sql",
  ];
  const input: BuildRiskAssessmentInput = {
    architectDeclaration: "high",
    stricterQualification: true,
    kernelFacts: {
      destructiveEffects: true,
      credentialEffects: true,
      externalWriteEffects: true,
      integrationConflict: true,
      changedPaths: paths,
    },
  };
  const reversed = {
    ...input,
    kernelFacts: { ...input.kernelFacts, changedPaths: [...paths].reverse() },
  };

  const assessment = assessBuildRisk(input);
  assert.deepEqual(assessment, assessBuildRisk(reversed));
  assert.deepEqual(reasonCodes(assessment), [
    "architect_declared_high",
    "stricter_qualification",
    "destructive_effect",
    "credential_effect",
    "external_write_effect",
    "integration_conflict",
    "security_auth_crypto_path",
    "migration_schema_data_path",
    "dependency_lockfile",
    "ci_deployment_infrastructure_path",
  ]);
  assert.deepEqual(assessment.normalizedChangedPaths, [
    ".github/workflows/ci.yml",
    "db/schema.sql",
    "package-lock.json",
    "src/auth/session.ts",
  ]);
  assert.deepEqual(
    assessment.reasons.find((reason) => reason.code === "security_auth_crypto_path")?.evidence,
    ["src/auth/session.ts"],
  );
});

test("assessment is pure and does not mutate caller-owned paths", () => {
  const changedPaths = ["src/auth/session.ts", "README.md"];
  const snapshot = [...changedPaths];
  const input = {
    ...LOW_RISK_INPUT,
    kernelFacts: { ...LOW_RISK_INPUT.kernelFacts, changedPaths },
  };

  const first = assessBuildRisk(input);
  const second = assessBuildRisk(input);
  assert.deepEqual(first, second);
  assert.deepEqual(changedPaths, snapshot);
  assert.notEqual(first.normalizedChangedPaths, changedPaths);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.reasons), true);
  assert.equal(Object.isFrozen(first.normalizedChangedPaths), true);
  assert.equal(Object.isFrozen(first.reasons[0]), true);
  assert.equal(Object.isFrozen(first.reasons[0]?.evidence), true);
  assert.throws(() => (first.normalizedChangedPaths as string[]).push("src/schema.ts"), TypeError);
  assert.throws(() => (first.reasons[0]!.evidence as string[]).push("forged"), TypeError);
});

function reasonCodes(assessment: ReturnType<typeof assessBuildRisk>): BuildRiskReasonCode[] {
  return assessment.reasons.map((reason) => reason.code);
}

function normalizeExpected(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}
