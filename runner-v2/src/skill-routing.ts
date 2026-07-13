import type { SkillMetadata } from "./skill-catalog.js";

export function rankSkillsForTask(
  metadata: readonly SkillMetadata[],
  objective: string,
  requiredCapabilities: readonly string[],
  limit: number
): SkillMetadata[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Skill selection limit must be positive.");
  }
  const objectiveTerms = new Set(meaningfulSkillTerms(objective));
  const capabilities = requiredCapabilities.map((capability) => ({
    key: skillKey(capability),
    terms: new Set(skillTerms(capability)),
    descriptionTerms: new Set(
      skillTerms(capability).filter(
        (term) => !GENERIC_CAPABILITY_TERMS.has(term)
      )
    ),
  }));
  const deduplicated = new Map<string, SkillMetadata>();
  for (const skill of metadata) {
    const key = skillKey(skill.name || skill.id.split("/").at(-1) || skill.id);
    const current = deduplicated.get(key);
    if (!current || compareSkillSource(skill, current) < 0) {
      deduplicated.set(key, skill);
    }
  }
  return [...deduplicated.values()]
    .map((skill) => {
      const nameKey = skillKey(skill.name);
      const idKey = skillKey(skill.id.split("/").at(-1) ?? skill.id);
      const nameTerms = new Set(skillTerms(`${skill.name} ${idKey}`));
      const descriptionTerms = new Set(skillTerms(skill.description));
      const meaningfulDescriptionTerms = new Set(
        meaningfulSkillTerms(skill.description)
      );
      const exactCapabilityIndex = capabilities.findIndex(
        (capability) => capability.key === nameKey || capability.key === idKey
      );
      const capabilityNameOverlap = capabilities.reduce(
        (total, capability) => total + intersectionSize(nameTerms, capability.terms),
        0
      );
      const capabilityDescriptionOverlap = capabilities.reduce(
        (total, capability) =>
          total + intersectionSize(descriptionTerms, capability.descriptionTerms),
        0
      );
      const objectiveNameOverlap = intersectionSize(nameTerms, objectiveTerms);
      const objectiveDescriptionOverlap = intersectionSize(
        meaningfulDescriptionTerms,
        objectiveTerms
      );
      return {
        skill,
        exactCapabilityIndex,
        capabilityNameOverlap,
        capabilityDescriptionOverlap,
        objectiveNameOverlap,
        objectiveDescriptionOverlap,
      };
    })
    .filter((item) =>
      item.exactCapabilityIndex >= 0 ||
      item.capabilityNameOverlap > 0 ||
      item.capabilityDescriptionOverlap > 0 ||
      item.objectiveNameOverlap > 0 ||
      item.objectiveDescriptionOverlap >= 2
    )
    .sort((left, right) => {
      const leftExact = left.exactCapabilityIndex >= 0;
      const rightExact = right.exactCapabilityIndex >= 0;
      return Number(rightExact) - Number(leftExact) ||
        (leftExact && rightExact
          ? left.exactCapabilityIndex - right.exactCapabilityIndex
          : 0) ||
        right.capabilityNameOverlap - left.capabilityNameOverlap ||
        right.capabilityDescriptionOverlap - left.capabilityDescriptionOverlap ||
        right.objectiveNameOverlap - left.objectiveNameOverlap ||
        right.objectiveDescriptionOverlap - left.objectiveDescriptionOverlap ||
        compareSkillSource(left.skill, right.skill) ||
        left.skill.id.localeCompare(right.skill.id);
    })
    .slice(0, limit)
    .map((item) => item.skill);
}

function skillTerms(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

const GENERIC_SKILL_TERMS = new Set([
  "a", "an", "and", "build", "create", "current", "for", "in", "of",
  "on", "project", "task", "the", "to", "use", "uses", "using", "with",
  "work",
]);

const GENERIC_CAPABILITY_TERMS = new Set([
  ...GENERIC_SKILL_TERMS,
  "code", "general", "image", "purpose", "reasoning", "text", "tool",
  "tools", "vision",
]);

function meaningfulSkillTerms(value: string): string[] {
  return skillTerms(value).filter((term) => !GENERIC_SKILL_TERMS.has(term));
}

function skillKey(value: string): string {
  return skillTerms(value).join("-");
}

function intersectionSize(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let total = 0;
  for (const value of left) if (right.has(value)) total += 1;
  return total;
}

function compareSkillSource(left: SkillMetadata, right: SkillMetadata): number {
  const priority: Record<SkillMetadata["source"], number> = {
    project: 0,
    user: 1,
    "built-in": 2,
  };
  return priority[left.source] - priority[right.source] ||
    left.id.localeCompare(right.id);
}
