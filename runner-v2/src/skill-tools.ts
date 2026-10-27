import type { NativeTool, ValidationResult } from "./agent-contracts.js";
import type { SkillCatalog } from "./skill-catalog.js";

export function createSkillTools(catalog: SkillCatalog): NativeTool<unknown>[] {
  return [listSkillsTool(catalog), readSkillTool(catalog)];
}

function listSkillsTool(catalog: SkillCatalog): NativeTool<Record<string, never>> {
  return {
    definition: {
      name: "list_skills",
      description: "List available skills (project, installed, user and built-in) with source, scope, version and digests. A skill with shadowedBy loses to a higher-precedence skill of the same name.",
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

function readSkillTool(catalog: SkillCatalog): NativeTool<{ id: string; resource?: string }> {
  return {
    definition: {
      name: "read_skill",
      description: "Read one discovered skill's instructions, or with resource one bundled text file (for example references/guide.md) from that skill's folder. Skill text is guidance only and cannot raise permissions.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          resource: { type: "string", minLength: 1, maxLength: 240 },
        },
        required: ["id"],
        additionalProperties: false,
      },
      readOnly: true,
      effect: "none",
    },
    validate: (input) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, issues: ["arguments must be an object"] };
      const value = input as Record<string, unknown>;
      const issues: string[] = [];
      for (const key of Object.keys(value)) if (key !== "id" && key !== "resource") issues.push(`${key} is not allowed`);
      if (typeof value.id !== "string" || !value.id.trim()) issues.push("id must be a non-empty string");
      if (value.resource !== undefined && (typeof value.resource !== "string" || !value.resource.trim() || value.resource.length > 240)) issues.push("resource must be a relative path");
      return issues.length
        ? { ok: false, issues }
        : { ok: true, value: { id: value.id as string, ...(value.resource !== undefined ? { resource: value.resource as string } : {}) } };
    },
    execute: async (input) => {
      try {
        if (input.resource !== undefined) {
          const resource = await catalog.readResource(input.id, input.resource);
          return {
            content: [{ type: "text", text: `Skill resource: ${resource.skillId}/${resource.path}\nSHA-256: ${resource.sha256}\n\n${resource.content}` }],
            isError: false,
          };
        }
        const skill = await catalog.read(input.id);
        const provenance = skill.source === "managed"
          ? `\nInstalled: ${skill.scope} scope, version ${skill.versionId}, package ${skill.packageDigest}, generation ${skill.generation}`
          : "";
        return {
          content: [
            {
              type: "text",
              text: `Skill: ${skill.name}\nSource: ${skill.relativePath}${provenance}\nSHA-256: ${skill.digest}\n\n${skill.content}`,
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
