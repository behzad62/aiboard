import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { NativeTool, ToolExecutionContext, ToolExecutionOutput, ValidationResult } from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";
import { isHiddenWorkspacePath } from "./filesystem-tools.js";
import { IMAGE_LIMITS, ImageInspectionError, prepareImageForModel, type ImageCrop, type PreparedImage } from "./image-inspection.js";

/** Runner tools whose artifact blocks may carry model-visible image metadata. */
export const RUNNER_VISUAL_TOOLS: ReadonlySet<string> = new Set(["image.inspect", "browser.screenshot"]);

type Input = Record<string, unknown>;

export interface ImageToolsOptions {
  readonly artifacts: ArtifactStore;
  readonly hiddenPaths?: readonly string[];
}

export function createImageTools(options: ImageToolsOptions): NativeTool<unknown>[] {
  const tool: NativeTool<Input> = {
    definition: {
      name: "image.inspect",
      description: "Look at a PNG, JPEG or WebP image from the workspace (path) or an image artifact (artifactHash, e.g. a browser screenshot). On an image-capable model the image is shown to you as image input in your next turn; a text-only model gets metadata and an explicit not-shown result. Optional crop (PNG) and maxDimension (64-2048, default 1568) bound what is sent. SVG is text: read it with fs.read.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          artifactHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          crop: { type: "object", properties: { x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 }, width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 } }, required: ["x", "y", "width", "height"], additionalProperties: false },
          maxDimension: { type: "integer", minimum: IMAGE_LIMITS.minMaxDimension, maximum: IMAGE_LIMITS.maxMaxDimension },
        },
        additionalProperties: false,
      },
      readOnly: true,
      effect: "none",
    },
    validate: validate,
    assessAccess: (input) => typeof input.path === "string"
      ? { capability: "image.inspect", paths: [{ path: input.path, access: "read" }] }
      : { capability: "image.inspect" },
    execute: async (input, context) => {
      try {
        const loaded = typeof input.path === "string" ? await readWorkspaceImage(context, input.path, options.hiddenPaths) : await readArtifactImage(options.artifacts, input.artifactHash as string);
        const prepared = prepareImageForModel(loaded.bytes, {
          ...(input.crop ? { crop: input.crop as ImageCrop } : {}),
          ...(input.maxDimension !== undefined ? { maxDimension: input.maxDimension as number } : {}),
        });
        const sourceFacts = { ...loaded.reference, mediaType: prepared.source.mediaType, width: prepared.source.width, height: prepared.source.height,
          byteLength: prepared.source.byteLength, sha256: prepared.sourceDigest, ...(prepared.source.orientation ? { exifOrientation: prepared.source.orientation } : {}) };
        if (context.imageInput !== true) {
          return {
            content: [{ type: "json", value: { shown: false, reason: "model_lacks_image_input", source: sourceFacts } }],
            isError: true,
            error: { code: "image_input_unsupported", message: "This model cannot receive image input, so the image was not shown to it. Only metadata is available; do not describe the image's contents." },
          };
        }
        return await deliver(options.artifacts, prepared, sourceFacts, loaded.label);
      } catch (error) {
        const code = error instanceof ImageInspectionError ? error.code : "image_unreadable";
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true, error: { code, message } };
      }
    },
  };
  return [tool as NativeTool<unknown>];
}

/** Shared by browser.screenshot: store the bounded derivative and return a visual artifact block. */
export async function visualArtifactOutput(artifacts: ArtifactStore, bytes: Uint8Array, label: string): Promise<{ block: Extract<ToolExecutionOutput["content"][number], { type: "artifact" }>; facts: Record<string, unknown> } | undefined> {
  let prepared: PreparedImage;
  try { prepared = prepareImageForModel(bytes); } catch { return undefined; }
  const stored = prepared.transforms.length ? await artifacts.put(prepared.bytes, prepared.mediaType, `${label} (model view)`) : { hash: prepared.sourceDigest };
  return {
    block: { type: "artifact", hash: stored.hash, mediaType: prepared.mediaType, label,
      visual: { width: prepared.width, height: prepared.height, sourceDigest: prepared.sourceDigest, ...(prepared.transforms.length ? { transforms: [...prepared.transforms] } : {}) } },
    facts: { modelView: { artifactHash: stored.hash, width: prepared.width, height: prepared.height, transforms: prepared.transforms } },
  };
}

async function deliver(artifacts: ArtifactStore, prepared: PreparedImage, source: Record<string, unknown>, label: string): Promise<ToolExecutionOutput> {
  // The derivative is a new artifact; the source file or artifact is never modified.
  const stored = await artifacts.put(prepared.bytes, prepared.mediaType, label);
  return {
    content: [
      { type: "json", value: {
        shown: true,
        delivery: "native image input in your next turn",
        source,
        delivered: { artifactHash: stored.hash, mediaType: prepared.mediaType, width: prepared.width, height: prepared.height, byteLength: prepared.bytes.byteLength, transforms: prepared.transforms },
        ...(prepared.notes.length ? { notes: prepared.notes } : {}),
      } },
      { type: "artifact", hash: stored.hash, mediaType: prepared.mediaType, label,
        visual: { width: prepared.width, height: prepared.height, sourceDigest: prepared.sourceDigest, ...(prepared.transforms.length ? { transforms: [...prepared.transforms] } : {}) } },
    ],
    isError: false,
  };
}

async function readWorkspaceImage(context: ToolExecutionContext, path: string, hiddenPaths?: readonly string[]) {
  if (!context.workspacePath) throw new ImageInspectionError("image_unreadable", "Image inspection requires a workspace.");
  const workspace = await realpath(context.workspacePath);
  const target = resolve(context.workspacePath, path);
  // The tool argument never grants host access: the canonical target must stay inside the workspace.
  let canonical: string;
  try { canonical = await realpath(target); } catch { throw new ImageInspectionError("image_unreadable", `No file at ${path}.`); }
  const inside = relative(workspace, canonical);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new ImageInspectionError("image_outside_workspace", "Images can only be inspected inside the workspace.");
  if (await isHiddenWorkspacePath(context, target, hiddenPaths)) throw new ImageInspectionError("image_hidden_path", "This path is hidden from agents.");
  const details = await lstat(canonical);
  if (!details.isFile()) throw new ImageInspectionError("image_unreadable", `${path} is not a regular file.`);
  if (details.size > IMAGE_LIMITS.maxSourceBytes) throw new ImageInspectionError("image_too_large", `Image exceeds ${IMAGE_LIMITS.maxSourceBytes} bytes.`);
  return { bytes: await readFile(canonical), reference: { path: inside.split(sep).join("/") }, label: `Image ${inside.split(sep).join("/")}` };
}

async function readArtifactImage(artifacts: ArtifactStore, hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new ImageInspectionError("invalid_arguments", "artifactHash must be a sha256 hex digest.");
  let bytes: Buffer;
  try { bytes = await artifacts.get(hash); } catch { throw new ImageInspectionError("image_unreadable", "No artifact with that hash is available to this run."); }
  return { bytes, reference: { artifactHash: hash }, label: `Image artifact ${hash.slice(0, 12)}` };
}

function validate(input: unknown): ValidationResult<Input> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, issues: ["input must be an object"] };
  const value = input as Input, issues: string[] = [];
  for (const key of Object.keys(value)) if (!["path", "artifactHash", "crop", "maxDimension"].includes(key)) issues.push(`${key} is not allowed`);
  if ((value.path === undefined) === (value.artifactHash === undefined)) issues.push("provide exactly one of path or artifactHash");
  if (value.path !== undefined && (typeof value.path !== "string" || !value.path)) issues.push("path must be a non-empty string");
  if (value.artifactHash !== undefined && typeof value.artifactHash !== "string") issues.push("artifactHash must be a string");
  if (value.maxDimension !== undefined && !Number.isSafeInteger(value.maxDimension)) issues.push("maxDimension must be an integer");
  if (value.crop !== undefined && (typeof value.crop !== "object" || value.crop === null)) issues.push("crop must be an object");
  return issues.length ? { ok: false, issues } : { ok: true, value };
}
