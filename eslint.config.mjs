import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  { ignores: [".claude/**", ".worktrees/**", "worktrees/**"] },
  ...nextCoreWebVitals,
  ...nextTypescript,
];

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
