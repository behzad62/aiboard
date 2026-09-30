import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      ".claude/**",
      ".worktrees/**",
      "worktrees/**",
      // Immutable RJS calibration source captures/proof bundles are evidence artifacts,
      // not active source. Lint the live harnesses and benchmark implementation instead.
      "benchmarks/recoverable-job-service/private/calibration/*-frozen-source/**",
      "benchmarks/recoverable-job-service/private/calibration/*-proof-*/**",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
];

eslintConfig.push({
  files: ["scripts/test-recoverable-job-service*.mts"],
  rules: {
    // These benchmark calibration/verification harnesses intentionally exercise
    // dynamic QuickJS/RPC boundary shapes. Requiring production-grade structural
    // typing here obscures the boundary probes without improving app type safety.
    "@typescript-eslint/no-explicit-any": "off",
  },
});

eslintConfig.push({
  files: ["benchmarks/recoverable-job-service/public/contract.d.ts"],
  rules: {
    // This generated/frozen public benchmark contract is byte-verified by the
    // release suite. Its optional `{}` argument is part of the published ABI.
    "@typescript-eslint/no-empty-object-type": "off",
  },
});

eslintConfig.push({
  files: [
    "scripts/test-recoverable-job-service-memory-growth.mts",
    "benchmarks/recoverable-job-service/private/quickjs-memory-shim.mjs",
  ],
  rules: {
    // Both files intentionally name the pinned Emscripten module object `module`.
    // The RJS release suite hashes these certified bytes, so rename-only edits
    // would invalidate the benchmark identity. This Next.js app rule is unrelated.
    "@next/next/no-assign-module-variable": "off",
  },
});
eslintConfig.push({
  rules: {
    // The React Hooks 7 compiler checks are useful signals, but this app does
    // not enable React Compiler yet. Do not warn on existing client-state
    // initialization patterns until the compiler migration is deliberate work.
    "react-hooks/preserve-manual-memoization": "off",
    "react-hooks/refs": "off",
    "react-hooks/set-state-in-effect": "off",
    "react-hooks/static-components": "off",
    "@typescript-eslint/no-unused-vars": [
      "warn",
      {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        ignoreRestSiblings: true,
        varsIgnorePattern: "^_",
      },
    ],
  },
});

export default eslintConfig;
