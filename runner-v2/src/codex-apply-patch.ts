/**
 * Codex-style `apply_patch` (a freeform custom tool whose input is a patch envelope), as DeepSeek
 * documents for its Responses API. One envelope may touch several files, but the filesystem fence
 * binds one trusted call to one mutation, so the model adapter splits an envelope into one
 * `openrouter.apply_patch` operation per file (each gated and fenced as before) and merges their
 * results back into the single output the provider expects for the call.
 */

export const NATIVE_PATCH_EXECUTOR = "openrouter.apply_patch";
const PART_SEPARATOR = "::apply_patch::";

export type CodexPatchOperation =
  | { type: "create_file"; path: string; diff: string }
  | { type: "update_file"; path: string; diff: string }
  | { type: "delete_file"; path: string };

/** Splits `*** Begin Patch ... *** End Patch` into per-file operations, or throws a message for the model. */
export function parseCodexPatch(text: string): CodexPatchOperation[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines.at(-1)!.trim() === "") lines.pop();
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === "") start += 1;
  if (lines[start]?.trim() !== "*** Begin Patch") throw new Error("The patch must start with '*** Begin Patch'.");
  if (lines.at(-1)?.trim() !== "*** End Patch") throw new Error("The patch must end with '*** End Patch'.");
  const body = lines.slice(start + 1, -1);
  const operations: CodexPatchOperation[] = [];
  let index = 0;
  while (index < body.length) {
    const header = body[index]!;
    const add = /^\*\*\* Add File: (.+)$/.exec(header);
    const remove = /^\*\*\* Delete File: (.+)$/.exec(header);
    const update = /^\*\*\* Update File: (.+)$/.exec(header);
    index += 1;
    const section: string[] = [];
    while (index < body.length && !/^\*\*\* (Add|Delete|Update) File: /.test(body[index]!)) {
      section.push(body[index]!);
      index += 1;
    }
    if (add) {
      if (section.some((line) => !line.startsWith("+"))) throw new Error(`Every line of added file ${add[1]!.trim()} must start with '+'.`);
      operations.push({ type: "create_file", path: add[1]!.trim(), diff: section.length ? `${section.join("\n")}\n` : "" });
    } else if (remove) {
      if (section.some((line) => line.trim() !== "")) throw new Error(`'*** Delete File: ${remove[1]!.trim()}' takes no lines.`);
      operations.push({ type: "delete_file", path: remove[1]!.trim() });
    } else if (update) {
      if (section[0]?.startsWith("*** Move to: ")) throw new Error("'*** Move to:' is not supported; add the new file and delete the old one.");
      const hunks = section.filter((line) => line !== "*** End of File");
      if (!hunks.length) throw new Error(`Update of ${update[1]!.trim()} has no changes.`);
      // A Codex patch may start its first hunk without an @@ line; the V4A executor requires one.
      const diff = (hunks[0] === "@@" || hunks[0]!.startsWith("@@ ") ? hunks : ["@@", ...hunks]).join("\n");
      operations.push({ type: "update_file", path: update[1]!.trim(), diff: `${diff}\n` });
    } else {
      throw new Error(`Unexpected line in the patch: '${header}'. Each file starts with '*** Add File:', '*** Update File:' or '*** Delete File:'.`);
    }
  }
  if (!operations.length) throw new Error("The patch changes no files.");
  return operations;
}

/** The call id of one per-file part, and its inverse. */
export function nativePatchPartId(callId: string, part: number): string {
  return `${callId}${PART_SEPARATOR}${part}`;
}
export function nativePatchCallId(partId: string): string | undefined {
  const at = partId.lastIndexOf(PART_SEPARATOR);
  return at > 0 && /^\d+$/.test(partId.slice(at + PART_SEPARATOR.length)) ? partId.slice(0, at) : undefined;
}

/** Codex's own result wording, so the model reads what it was trained on. */
export function mergeNativePatchResults(
  results: ReadonlyArray<{ operation?: CodexPatchOperation; isError: boolean; text: string }>,
): string {
  const failed = results.filter((result) => result.isError);
  const done = results.filter((result) => !result.isError && result.operation);
  const letter = (operation: CodexPatchOperation) =>
    operation.type === "create_file" ? "A" : operation.type === "delete_file" ? "D" : "M";
  const applied = done.map((result) => `${letter(result.operation!)} ${result.operation!.path}`).join("\n");
  // Lines after a part's first line are notices (e.g. "submit_task will refuse ..."); keep them.
  const notices = done.flatMap((result) => result.text.split("\n").slice(1)).filter((line) => line.trim());
  const notes = notices.length ? `\n${notices.join("\n")}` : "";
  if (!failed.length) return `Success. Updated the following files:\n${applied}${notes}`;
  const errors = failed.map((result) => result.text).join("\n");
  return `apply_patch verification failed: ${errors}${applied ? `\nThese parts were applied: \n${applied}` : ""}${notes}`;
}
