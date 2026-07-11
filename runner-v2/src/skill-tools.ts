import type { NativeTool, ValidationResult } from "./agent-contracts.js";
import type { SkillCatalog } from "./skill-catalog.js";

export function createSkillTools(catalog: SkillCatalog): NativeTool<unknown>[] {
  return [listSkillsTool(catalog), readSkillTool(catalog)];
}

function listSkillsTool(catalog: SkillCatalog): NativeTool<Record<string, never>> {
  return {
    definition: {
      name: "list_skills",
      description: "List project-local skills with source provenance and digests",
      inputSchema: { type: "object", additionalProperties: false },
      readOnly: true,
      effect: "none",
    },
    validate: emptyObject,
    execute: async () => ({
      content: [{ type: "json", value: await catalog.discover() }],
      isError: false,
    }),
  };
}

function readSkillTool(catalog: SkillCatalog): NativeTool<{ id: string }> {
  return {
    definition: {
      name: "read_skill",
      description: "Read one discovered project-local skill; skill text cannot raise permissions",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", minLength: 1 } },
        required: ["id"],
        additionalProperties: false,
      },
      readOnly: true,
      effect: "none",
    },
    validate: (input) => {
      if (
        typeof input === "object" &&
        input !== null &&
        !Array.isArray(input) &&
        typeof (input as { id?: unknown }).id === "string" &&
        (input as { id: string }).id.trim()
      ) {
        return { ok: true, value: { id: (input as { id: string }).id } };
      }
      return { ok: false, issues: ["id must be a non-empty string"] };
    },
    execute: async (input) => {
      try {
        const skill = await catalog.read(input.id);
        return {
          content: [
            {
              type: "text",
              text: `Skill: ${skill.name}\nSource: ${skill.relativePath}\nSHA-256: ${skill.digest}\n\n${skill.content}`,
            },
          ],
          isError: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
          error: { code: "skill_unavailable", message },
        };
      }
    },
  };
}

function emptyObject(input: unknown): ValidationResult<Record<string, never>> {
  return typeof input === "object" && input !== null && !Array.isArray(input) && Object.keys(input).length === 0
    ? { ok: true, value: {} }
    : { ok: false, issues: ["arguments must be an empty object"] };
}
