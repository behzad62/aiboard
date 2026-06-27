import type { ChatMessage, SelectedModel } from "@/lib/providers/base";

export type CertifiedMockModelKind =
  | "oracle"
  | "bad-json"
  | "forbidden-tool"
  | "no-output"
  | "slow"
  | "wrong-patch";

export interface CertifiedMockModel extends SelectedModel {
  kind: CertifiedMockModelKind;
  responseFor(input: {
    label: string;
    messages: ChatMessage[];
  }): Promise<string>;
}

function createMockModel(
  kind: CertifiedMockModelKind,
  displayName: string,
  responder: CertifiedMockModel["responseFor"]
): CertifiedMockModel {
  return {
    kind,
    modelId: `certified:${kind}`,
    providerId: "certified",
    displayName,
    responseFor: responder,
  };
}

export const OracleModel = createMockModel("oracle", "Oracle Model", async ({ label }) => {
  if (/review/i.test(label)) {
    return JSON.stringify({
      action: "review",
      results: [{ taskId: "T1", verdict: "approve", feedback: "Verifier passed." }],
      newTasks: [],
      done: true,
      notes: "Certified oracle completed the task.",
    });
  }
  if (/summary|handoff/i.test(label)) {
    return "Implemented the requested fix and passed the verifier.";
  }
  return JSON.stringify({
    action: "plan",
    tasks: [
      {
        id: "T1",
        title: "Apply simple fixture patch",
        instructions: "Patch src/add.ts so add returns a + b.",
        contextFiles: ["src/add.ts"],
        outputPaths: ["src/add.ts"],
        expectedOutputs: "src/add.ts returns a + b",
        dependsOn: [],
        difficulty: 1,
      },
    ],
    notes: "Use the verifier command only.",
    verifyCommand: "npm test",
  });
});

export const BadJsonModel = createMockModel(
  "bad-json",
  "Bad JSON Model",
  async () => "{ action: plan, tasks: ["
);

export const ForbiddenToolModel = createMockModel(
  "forbidden-tool",
  "Forbidden Tool Model",
  async () =>
    JSON.stringify({
      action: "run",
      command: "git push origin main",
      reason: "publish result",
    })
);

export const NoOutputModel = createMockModel(
  "no-output",
  "No Output Model",
  async () => ""
);

export const SlowModel = createMockModel("slow", "Slow Model", async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return "timeout";
});

export const WrongPatchModel = createMockModel(
  "wrong-patch",
  "Wrong Patch Model",
  async () =>
    [
      "```edit path=src/add.ts",
      "<<<<<<< SEARCH",
      "  return a - b;",
      "=======",
      "  return a * b;",
      ">>>>>>> REPLACE",
      "```",
    ].join("\n")
);

export const CERTIFIED_MOCK_MODELS = [
  OracleModel,
  BadJsonModel,
  ForbiddenToolModel,
  NoOutputModel,
  SlowModel,
  WrongPatchModel,
] as const;

export function getCertifiedMockModel(
  kind: CertifiedMockModelKind
): CertifiedMockModel {
  const model = CERTIFIED_MOCK_MODELS.find((item) => item.kind === kind);
  if (!model) throw new Error(`Unknown certified mock model: ${kind}`);
  return model;
}
