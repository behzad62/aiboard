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
    // not enable React Compiler yet. Keep upgrade-time linting actionable
    // without rewriting existing synchronous client-state effects.
    "react-hooks/preserve-manual-memoization": "warn",
    "react-hooks/refs": "warn",
    "react-hooks/set-state-in-effect": "warn",
    "react-hooks/static-components": "warn",
  },
});

export default eslintConfig;
