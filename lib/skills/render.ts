import { getSkillCards } from "./registry";
import { selectSkills } from "./router";
import type { SkillActivation, SkillActivationInput, SkillCard } from "./types";

function actorList(skill: SkillCard): string {
  return skill.actors.join("/");
}

function renderSkillList(title: string, ids: string[], mode: "compact" | "overlay"): string {
  const cards = getSkillCards(ids);
  if (cards.length === 0) return "";
  if (mode === "compact") {
    return [
      title,
      ...cards.map((skill) => {
        const trigger = skill.triggers.slice(0, 2).join("; ");
        return `- ${skill.id} [${skill.phase}; ${actorList(skill)}]: ${skill.title} - ${trigger}`;
      }),
    ].join("\n");
  }
  return [
    title,
    ...cards.map((skill) =>
      [
        `### ${skill.id}: ${skill.title}`,
        `Source: ${skill.source}. Applies to: ${skill.actors.join(", ")}. Persistence: ${skill.persistence}.`,
        skill.compact,
      ].join("\n")
    ),
  ].join("\n\n");
}

export function activeSkillIds(activation: SkillActivation): string[] {
  return [...activation.always, ...activation.overlays];
}

export function renderSkillContext(activation: SkillActivation): string {
  const sections = [
    "BUILD SKILL CONTEXT",
    renderSkillList("AIBoard Build OS (always active)", activation.always, "overlay"),
    renderSkillList("Compact Skill Index", activation.index, "compact"),
    renderSkillList("Active Skill Overlays", activation.overlays, "overlay"),
    activation.evidenceRequired.length > 0
      ? [
          "Skill evidence required",
          ...activation.evidenceRequired.map((item) => `- ${item}`),
          "In final prose, include a short `Skill evidence:` section with the evidence or exemption reason.",
        ].join("\n")
      : "",
  ];

  return sections.filter((section) => section.trim()).join("\n\n");
}

export function buildSkillContext(input: SkillActivationInput): string {
  return renderSkillContext(selectSkills(input));
}
