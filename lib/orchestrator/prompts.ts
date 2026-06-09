import type { DiscussionMode } from "../db/schema";
import type { SelectedModel } from "../providers/base";

export function buildRoundSystemPrompt(
  mode: DiscussionMode,
  round: number,
  maxRounds: number,
  models: SelectedModel[],
  leadIndex?: number
): string {
  const modelNames = models.map((m) => m.displayName).join(", ");

  const base = `You are participating in a multi-AI discussion with: ${modelNames}.
The user asked a question and multiple AI models are collaborating to produce the best answer.
Be concise but thorough. Reference other participants by name when agreeing or disagreeing.
This is round ${round} of ${maxRounds}.`;

  if (mode === "panel") {
    if (round === 1) {
      return `${base}
Round 1 — Initial Analysis: Provide your best initial answer to the user's question.
Structure your response clearly. State assumptions where relevant.`;
    }
    if (round === maxRounds) {
      return `${base}
Final discussion round — Refinement: Synthesize the best points from the discussion.
Explicitly note any remaining disagreements and your recommended resolution.`;
    }
    return `${base}
Round ${round} — Critique & Refine: Review what other models said in prior rounds.
Correct errors, add missing details, and build on strong points. Avoid repeating unchanged content.`;
  }

  if (mode === "debate") {
    const positions = models.map((m, i) => `${m.displayName}: ${i % 2 === 0 ? "PRO" : "CON"}`);
    return `${base}
Debate mode. Assigned positions: ${positions.join("; ")}.
Round ${round}: Argue your assigned position while engaging with counterpoints fairly.
In later rounds, acknowledge valid points from the other side before rebutting.`;
  }

  const lead = models[leadIndex ?? 0];
  const reviewers = models.filter((_, i) => i !== (leadIndex ?? 0));
  if (round === 1) {
    if (leadIndex === 0 || round === 1) {
      return `${base}
Specialist mode — You are ${lead.displayName}, the lead drafter.
Produce a comprehensive initial draft answer to the user's question.`;
    }
  }

  const isLead = leadIndex !== undefined;
  if (isLead && models[leadIndex!]?.displayName) {
    return `${base}
Specialist mode — You are ${models[leadIndex!].displayName}, revising the draft based on reviewer feedback.
Incorporate valid critiques and improve the draft.`;
  }

  return `${base}
Specialist mode — You are a reviewer (${reviewers.map((r) => r.displayName).join(", ")} are also reviewing).
Critique the lead draft: identify errors, gaps, and improvements. Do not rewrite the entire answer.`;
}

export function buildUserPrompt(
  topic: string,
  transcript: string,
  attachmentText = ""
): string {
  const topicBlock = attachmentText
    ? `${topic}${attachmentText}`
    : topic;

  if (!transcript.trim()) {
    return `User question:\n\n${topicBlock}`;
  }
  return `User question:\n\n${topicBlock}\n\n--- Discussion so far ---\n\n${transcript}`;
}

export function buildConvergencePrompt(topic: string, transcript: string): string {
  return `The user asked: "${topic}"

Here is the discussion transcript so far:

${transcript}

Rate how complete and accurate the current collective answer is on a scale of 1-10.
Respond with ONLY a JSON object: {"score": <number>, "reason": "<brief reason>"}`;
}

export function buildJudgePrompt(topic: string, transcript: string): string {
  return `You are the final judge synthesizing a multi-AI discussion.

User question:
${topic}

Full discussion transcript:
${transcript}

Produce the definitive best answer for the user. Include:
1. A clear, comprehensive answer
2. Key formulas, steps, or design decisions (as applicable)
3. Important caveats or assumptions

Respond with ONLY a JSON object in this format:
{
  "answer": "<full markdown answer for the user>",
  "confidence": <number 0-10>,
  "dissent": ["<any unresolved disagreement>", "..."]
}`;
}

export function formatTranscript(
  entries: Array<{ modelName: string; round: number; content: string }>
): string {
  return entries
    .map((e) => `[Round ${e.round}] ${e.modelName}:\n${e.content}`)
    .join("\n\n");
}

export function buildTranscriptFromMessages(
  messages: Array<{ round: number; modelId: string; content: string }>,
  modelNames: Record<string, string>
): string {
  return formatTranscript(
    messages.map((m) => ({
      round: m.round,
      modelName: modelNames[m.modelId] ?? m.modelId,
      content: m.content,
    }))
  );
}
