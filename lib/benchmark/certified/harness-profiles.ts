import type { HarnessProfile } from "@/lib/benchmark/types";

export interface HarnessProfileDefinition {
  profile: HarnessProfile;
  label: string;
  description: string;
  harnessVersion: string;
  promptSetVersion: string;
  runnerRequired: boolean;
  runnerOnly: boolean;
  disableMcpByDefault: boolean;
  allowedCommands: string[];
}

const COMMON_BUILD_COMMANDS = [
  "npm test",
  "npm run test",
  "npm run build",
  "npx tsc --noEmit",
];

export const HARNESS_PROFILE_DEFINITIONS: HarnessProfileDefinition[] = [
  {
    profile: "raw-single-model",
    label: "Raw single model",
    description: "Direct model call without AI Board orchestration.",
    harnessVersion: "raw-single-model-v0.1",
    promptSetVersion: "certified-prompts-v0.1",
    runnerRequired: false,
    runnerOnly: false,
    disableMcpByDefault: true,
    allowedCommands: [],
  },
  {
    profile: "aiboard-single-model",
    label: "AI Board single model",
    description: "One model routed through AI Board orchestration.",
    harnessVersion: "aiboard-single-model-v0.1",
    promptSetVersion: "certified-prompts-v0.1",
    runnerRequired: false,
    runnerOnly: false,
    disableMcpByDefault: true,
    allowedCommands: [],
  },
  {
    profile: "aiboard-panel",
    label: "AI Board panel",
    description: "Panel discussion harness using certified prompt and trace rules.",
    harnessVersion: "aiboard-panel-v0.1",
    promptSetVersion: "certified-prompts-v0.1",
    runnerRequired: false,
    runnerOnly: false,
    disableMcpByDefault: true,
    allowedCommands: [],
  },
  {
    profile: "aiboard-debate",
    label: "AI Board debate",
    description: "Debate harness using certified prompt and trace rules.",
    harnessVersion: "aiboard-debate-v0.1",
    promptSetVersion: "certified-prompts-v0.1",
    runnerRequired: false,
    runnerOnly: false,
    disableMcpByDefault: true,
    allowedCommands: [],
  },
  {
    profile: "aiboard-specialist",
    label: "AI Board specialist panel",
    description: "Specialist discussion harness using certified prompt and trace rules.",
    harnessVersion: "aiboard-specialist-v0.1",
    promptSetVersion: "certified-prompts-v0.1",
    runnerRequired: false,
    runnerOnly: false,
    disableMcpByDefault: true,
    allowedCommands: [],
  },
  {
    profile: "aiboard-build-single-worker",
    label: "AI Board Build single worker",
    description: "Build mode with one worker in a certified runner sandbox.",
    harnessVersion: "aiboard-build-single-worker-v0.1",
    promptSetVersion: "certified-build-prompts-v0.1",
    runnerRequired: true,
    runnerOnly: true,
    disableMcpByDefault: true,
    allowedCommands: COMMON_BUILD_COMMANDS,
  },
  {
    profile: "aiboard-build-multi-worker",
    label: "AI Board Build multi-worker",
    description: "Build mode with multiple workers in a certified runner sandbox.",
    harnessVersion: "aiboard-build-multi-worker-v0.1",
    promptSetVersion: "certified-build-prompts-v0.1",
    runnerRequired: true,
    runnerOnly: true,
    disableMcpByDefault: true,
    allowedCommands: COMMON_BUILD_COMMANDS,
  },
  {
    profile: "external-mini-swe-agent",
    label: "External mini SWE agent",
    description: "External harness adapter for mini-SWE-agent compatible runs.",
    harnessVersion: "external-mini-swe-agent-v0.1",
    promptSetVersion: "external-certified-prompts-v0.1",
    runnerRequired: true,
    runnerOnly: true,
    disableMcpByDefault: true,
    allowedCommands: COMMON_BUILD_COMMANDS,
  },
  {
    profile: "external-custom",
    label: "External custom",
    description: "Custom external certified harness adapter.",
    harnessVersion: "external-custom-v0.1",
    promptSetVersion: "external-certified-prompts-v0.1",
    runnerRequired: true,
    runnerOnly: true,
    disableMcpByDefault: true,
    allowedCommands: COMMON_BUILD_COMMANDS,
  },
];

export function listHarnessProfileDefinitions(): HarnessProfileDefinition[] {
  return HARNESS_PROFILE_DEFINITIONS.map((profile) => ({ ...profile }));
}

export function getHarnessProfileDefinition(
  profile: HarnessProfile
): HarnessProfileDefinition | null {
  const found = HARNESS_PROFILE_DEFINITIONS.find(
    (definition) => definition.profile === profile
  );
  return found ? { ...found } : null;
}
