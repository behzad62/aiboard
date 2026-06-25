import { AIBOARD_CORE_SKILLS } from "./packs/aiboard-core";
import { AGENT_SKILLS } from "./packs/agent-skills";
import { SUPERPOWERS_SKILLS } from "./packs/superpowers";
import type { SkillCard } from "./types";

export const SKILL_REGISTRY: SkillCard[] = [
  ...AIBOARD_CORE_SKILLS,
  ...AGENT_SKILLS,
  ...SUPERPOWERS_SKILLS,
];

const SKILL_BY_ID = new Map(SKILL_REGISTRY.map((skill) => [skill.id, skill]));

export function getSkillCard(id: string): SkillCard | null {
  return SKILL_BY_ID.get(id) ?? null;
}

export function getSkillCards(ids: string[]): SkillCard[] {
  return ids
    .map((id) => getSkillCard(id))
    .filter((skill): skill is SkillCard => skill != null);
}

export function allSkillIds(): string[] {
  return SKILL_REGISTRY.map((skill) => skill.id);
}

export function compactSkillIndexIds(): string[] {
  return SKILL_REGISTRY.filter((skill) => skill.persistence !== "always").map(
    (skill) => skill.id
  );
}
