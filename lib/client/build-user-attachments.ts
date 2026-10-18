/** Browser-side build attachment staging; binary content goes only to Runner V2. */
import { buildGuidanceWithTextFiles, isBuildTextFile, validateBuildTextFiles } from "./build-guidance-files";
export type BuildVisualFile = { filename: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "application/pdf"; base64Data: string };
export function visualFileMime(file: Pick<File, "name" | "type">): BuildVisualFile["mimeType"] | null {
  const suffix = file.name.toLowerCase();
  const inferred = suffix.endsWith(".png") ? "image/png" : suffix.endsWith(".jpg") || suffix.endsWith(".jpeg") ? "image/jpeg"
    : suffix.endsWith(".webp") ? "image/webp" : suffix.endsWith(".pdf") ? "application/pdf" : null;
  if (!inferred) return null;
  if (file.type && file.type !== inferred && !(inferred === "image/jpeg" && file.type === "image/jpg")) return null;
  return inferred;
}
export function validateBuildComposerFiles(files: readonly File[]): string | null {
  const text = files.filter((file) => isBuildTextFile(file.name, file.type));
  const visual = files.filter((file) => !isBuildTextFile(file.name, file.type));
  const textIssue = validateBuildTextFiles(text);
  if (textIssue) return textIssue;
  if (visual.length > 3) return "Attach at most 3 images/PDFs per message.";
  if (visual.some((file) => !visualFileMime(file))) return "Only text, PNG, JPEG, WebP, and PDF files are supported.";
  if (visual.some((file) => file.size > 8 * 1024 * 1024 || file.size === 0)) return "Each image/PDF must be between 1 byte and 8 MiB.";
  if (visual.reduce((size, file) => size + file.size, 0) > 12 * 1024 * 1024) return "Images/PDFs must total at most 12 MiB.";
  return null;
}
async function fileBase64(file: File): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read attachment."));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      const pos = value.indexOf(",");
      if (pos < 0) return reject(new Error("Could not encode attachment."));
      resolve(value.slice(pos + 1));
    };
    reader.readAsDataURL(file);
  });
}
export async function prepareBuildUserAttachments(text: string, files: readonly File[]): Promise<{ text: string; attachments: BuildVisualFile[] }> {
  const issue = validateBuildComposerFiles(files);
  if (issue) throw new Error(issue);
  const textual = files.filter((file) => isBuildTextFile(file.name, file.type));
  const binary = files.filter((file) => !isBuildTextFile(file.name, file.type));
  const [content, attachments] = await Promise.all([
    buildGuidanceWithTextFiles(text, textual),
    Promise.all(binary.map(async (file) => ({
      filename: file.name,
      mimeType: visualFileMime(file)!,
      base64Data: await fileBase64(file),
    }))),
  ]);
  return { text: content || (attachments.length ? "Please inspect the attached visual evidence." : ""), attachments };
}
