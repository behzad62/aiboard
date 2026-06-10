import type { DiscussionMode, Verbosity } from "../db/schema";
import type { SelectedModel } from "../providers/base";

export const DISCUSSION_TRANSCRIPT_MARKER = "\n\n--- Discussion so far ---\n\n";

const FENCE = "```";

/**
 * How models should emit files in Build mode. Kept fence-safe (no nested
 * backticks inside a template literal) by composing from a FENCE constant.
 */
export const FILE_OUTPUT_INSTRUCTION = [
  "When you provide a file, output it as a fenced code block whose info line includes the path, for example:",
  "",
  FENCE + "ts path=src/index.ts",
  "// the complete contents of the file go here",
  FENCE,
  "",
  "Rules: one fenced block per file; give the COMPLETE contents of every file you write (no '...' elisions); use real relative paths (e.g. path=app/page.tsx); keep explanations and discussion OUTSIDE the code blocks.",
].join("\n");

const VERBOSITY_GUIDANCE: Record<Verbosity, string> = {
  brief:
    "Keep your response as short as possible while still fully answering. Lead with the answer, prefer tight bullet points, and omit preamble, throat-clearing, and restated context.",
  balanced:
    "Be clear and reasonably thorough. Explain the key points without padding.",
  comprehensive:
    "Be thorough: cover your reasoning, alternatives, caveats, and concrete examples where useful.",
  exhaustive:
    "Be exhaustive and rigorous: cover edge cases, trade-offs, and alternatives, and justify your recommendations in depth.",
};

/**
 * Turns the user's chosen detail level + free-form style note into a prompt
 * instruction. This is how conciseness is controlled — never by truncating
 * tokens — so models comply instead of getting cut off.
 */
export function buildVerbosityInstruction(
  verbosity: Verbosity,
  styleNote?: string | null
): string {
  const note = styleNote?.trim()
    ? `\nAdditional style guidance from the user: ${styleNote.trim()}`
    : "";
  return `Response style: ${VERBOSITY_GUIDANCE[verbosity] ?? VERBOSITY_GUIDANCE.balanced}${note}`;
}

export function buildRoundSystemPrompt(
  mode: DiscussionMode,
  round: number,
  maxRounds: number,
  models: SelectedModel[],
  currentIndex: number,
  leadIndex?: number,
  verbosityInstruction?: string
): string {
  const modelNames = models.map((m) => m.displayName).join(", ");
  const me = models[currentIndex]?.displayName ?? "a participant";

  const base = `You are ${me}, participating in a multi-AI discussion with: ${modelNames}.
The user asked a question and multiple AI models are collaborating to produce the best result.
Be substantive. Reference other participants by name when agreeing or disagreeing.
This is round ${round} of ${maxRounds}.`;

  let body: string;

  if (mode === "panel") {
    if (round === 1) {
      body = `Round 1 — Initial Analysis: Provide your best initial answer to the user's question. Structure your response clearly and state assumptions where relevant.`;
    } else if (round === maxRounds) {
      body = `Final round — Refinement: Synthesize the strongest points from the discussion. Explicitly note any remaining disagreements and your recommended resolution.`;
    } else {
      body = `Round ${round} — Critique & Refine: Review what other models said so far. Correct errors, add missing details, and build on strong points. Avoid repeating unchanged content.`;
    }
  } else if (mode === "debate") {
    // Sides alternate by selection order; with an odd model count one side has
    // an extra voice, which the prompt acknowledges so models argue on merit.
    const mySide = currentIndex % 2 === 0 ? "FOR" : "AGAINST";
    const forSide = models
      .filter((_, i) => i % 2 === 0)
      .map((m) => m.displayName)
      .join(", ");
    const againstSide = models
      .filter((_, i) => i % 2 === 1)
      .map((m) => m.displayName)
      .join(", ");
    const sides = `Treat the user's question as a proposition. FOR side: ${forSide || "none"}. AGAINST side: ${againstSide || "none"}. Sides may be uneven — argue on the merits, not by majority.`;

    let roundTask: string;
    if (round === 1) {
      roundTask = `Round 1 — Opening: Steelman your side. Make the strongest honest case ${mySide === "FOR" ? "for" : "against"} the proposition, with concrete evidence, examples, and the criteria you think the decision should turn on.`;
    } else if (round === maxRounds) {
      roundTask = `Final round — Closing: State your side's strongest surviving argument, concede the points from the other side that are genuinely valid, and name the crux — the specific fact or value judgment on which the decision actually turns.`;
    } else {
      roundTask = `Round ${round} — Rebuttal: Engage the other side's specific arguments by name. Refute what is weak, acknowledge what is strong, and sharpen where the real disagreement lies. Do not repeat your opening.`;
    }

    body = `Debate mode — You are arguing the ${mySide} position.
${sides}
${roundTask}`;
  } else if (mode === "specialist") {
    const isLead = currentIndex === (leadIndex ?? 0);
    if (isLead) {
      body =
        round === 1
          ? `Specialist mode — You are the lead drafter. Produce a comprehensive initial draft answer to the user's question.`
          : `Specialist mode — You are the lead. Revise your draft, incorporating the reviewers' valid critiques and improving weak areas.`;
    } else {
      body = `Specialist mode — You are a reviewer. Critique the lead's draft: identify errors, gaps, and concrete improvements. Do not rewrite the entire answer; focus your feedback.`;
    }
  } else {
    // build
    if (round === 1) {
      body = `Round 1 — Architecture & Plan: As a team, propose the project structure, tech stack, file tree, key interfaces/contracts, and a short build plan. Agree on conventions. Do NOT write full implementations yet — focus on a crisp, shared design.`;
    } else if (round === maxRounds) {
      body = `Final round — Converge & Complete: Ensure the project is consistent and complete. Write or finalize the file contents you are responsible for, fix remaining issues, and resolve contradictions.\n\n${FILE_OUTPUT_INSTRUCTION}`;
    } else {
      body = `Round ${round} — Implement & Critique: Write actual file contents for the parts you can best contribute, and review others' files — fix bugs, fill gaps, and resolve inconsistencies.\n\n${FILE_OUTPUT_INSTRUCTION}`;
    }
  }

  return [base, body, verbosityInstruction].filter(Boolean).join("\n\n");
}

export function buildUserPrompt(
  topic: string,
  transcript: string,
  attachmentText = ""
): string {
  const topicBlock = attachmentText ? `${topic}${attachmentText}` : topic;

  if (!transcript.trim()) {
    return `User question:\n\n${topicBlock}`;
  }
  return `User question:\n\n${topicBlock}${DISCUSSION_TRANSCRIPT_MARKER}${transcript}`;
}

export function buildConvergencePrompt(topic: string, transcript: string): string {
  return `The user asked: "${topic}"

Here is the discussion transcript so far:

${transcript}

Rate how complete and accurate the current collective answer is on a scale of 1-10.
Respond with ONLY a JSON object: {"score": <number>, "reason": "<brief reason>"}`;
}

export const META_FOOTER_INSTRUCTION = [
  "After the answer, append EXACTLY this metadata block on its own lines and write nothing after it:",
  "",
  "---",
  "<!--meta",
  "confidence: <integer 0-10>",
  "dissent:",
  "- <one unresolved disagreement per line, or leave the list empty if there are none>",
  "-->",
].join("\n");

const JUDGE_MODE_GUIDANCE: Partial<Record<DiscussionMode, string>> = {
  debate:
    "This was a structured debate with assigned FOR/AGAINST sides. Weigh the strongest case from each side on its merits (not by how many models argued it), then deliver a clear verdict: what the user should do, why, and under what specific conditions the verdict would flip. Note the cruxes the debaters identified.",
  specialist:
    "This was a lead-drafter-plus-reviewers process. The lead's final revision is the primary candidate answer — preserve its structure and voice, and fold in any reviewer corrections it failed to incorporate rather than rewriting from scratch.",
};

export function buildJudgePrompt(
  topic: string,
  transcript: string,
  verbosityInstruction = "",
  mode?: DiscussionMode
): string {
  return [
    "You are the final judge synthesizing a multi-AI discussion.",
    "",
    "User question:",
    topic,
    "",
    "Full discussion transcript:",
    transcript,
    "",
    "Produce the single best answer for the user in GitHub-flavored Markdown. Include the key points, and any formulas, steps, or design decisions that apply, plus important caveats or assumptions.",
    mode ? JUDGE_MODE_GUIDANCE[mode] ?? "" : "",
    verbosityInstruction,
    "",
    "Do NOT wrap the answer in JSON. Write the answer as normal Markdown.",
    META_FOOTER_INSTRUCTION,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildIntegratorPrompt(
  topic: string,
  transcript: string,
  verbosityInstruction = ""
): string {
  return [
    "You are the integrator finalizing a collaborative software/build project.",
    "",
    "Project request:",
    topic,
    "",
    "Full discussion transcript (designs, drafts, critiques):",
    transcript,
    "",
    "Assemble the FINAL, coherent project. Output every file in full using this exact format:",
    "",
    FENCE + "lang path=relative/path",
    "...complete file contents...",
    FENCE,
    "",
    "Requirements:",
    "- Include every file needed to run the project; give complete contents, not snippets.",
    "- Resolve conflicts and inconsistencies between the participants' drafts.",
    "- Use consistent naming, imports, and conventions across files.",
    "- After all files, add a section that starts with the heading '## Build notes' covering how to run it, the key decisions, and any follow-ups.",
    verbosityInstruction,
    "",
    META_FOOTER_INSTRUCTION,
  ]
    .filter(Boolean)
    .join("\n");
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
