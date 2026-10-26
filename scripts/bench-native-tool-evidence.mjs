import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Read only the ledger owned by the managed attempt; callers never supply a filesystem path. */
export async function readNativeToolEvidence(statePath, runId) {
  if (typeof runId !== "string" || !/^[a-zA-Z0-9._-]{1,120}$/.test(runId)) throw new Error("Invalid native benchmark run identity.");
  const readable = runId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
  const segment = `${readable}-${createHash("sha256").update(runId).digest("hex").slice(0, 10)}`;
  const path = join(statePath, "builds", segment, "tool-ledger.sqlite");
  const root = await realpath(statePath);
  const actual = await realpath(path);
  const traversal = relative(root, actual);
  if (!traversal || traversal.startsWith("..") || isAbsolute(traversal) || (await lstat(path)).isSymbolicLink()) throw new Error("Native benchmark ledger escapes its owned state.");
  const db = new DatabaseSync(actual, { readOnly: true });
  try {
    const rows = db.prepare("SELECT sequence, hex(invocation_key) AS key_hex, event_type, fingerprint, occurred_at, payload_json FROM tool_events ORDER BY sequence LIMIT 10001").all();
    if (rows.length > 10000) throw new Error("Native benchmark tool evidence exceeds its bound.");
    const output = [];
    let size = 0;
    for (const row of rows) {
      if (!Buffer.from(row.key_hex, "hex").toString("utf8").startsWith(`${runId}\0`)) throw new Error("Native ledger contains another run identity.");
      if (row.event_type !== "tool.completed") continue;
      const result = JSON.parse(row.payload_json);
      const [name, args] = JSON.parse(row.fingerprint);
      // Only tool results for benchmark filesystem investigation/edits are needed here.
      // Do not export arbitrary process environments, credentials, or external tool arguments.
      if (!["fs.read", "fs.search", "fs.patch", "fs.write", "artifact.read", "openrouter.apply_patch"].includes(name)) continue;
      const input = args && typeof args === "object" ? args : {};
      const operation = name === "openrouter.apply_patch" ? input.operation : undefined;
      const diffLines = typeof operation?.diff === "string" ? operation.diff.split(/\r?\n/) : [];
      // Native provider patches cover several edits in one single-file operation.
      // Count paired removed/added lines, not arbitrary diff/context text.
      const nativeEditCount = operation?.type === "update_file" ? Math.min(
        diffLines.filter(line => line.startsWith("-")).length,
        diffLines.filter(line => line.startsWith("+")).length,
      ) : 0;
      const record = {
        sequence: row.sequence, callId: result.callId, toolName: name,
        input: { path: input.path ?? operation?.path, startLine: input.startLine, endLine: input.endLine, editCount: operation ? nativeEditCount : Array.isArray(input.edits) ? input.edits.length : name === "fs.patch" ? 1 : undefined },
        isError: result.isError === true, errorCode: result.error?.code,
        outputText: (result.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n").slice(0, 64 * 1024),
      };
      size += Buffer.byteLength(JSON.stringify(record));
      if (size > 4 * 1024 * 1024) throw new Error("Native benchmark tool evidence exceeds its byte bound.");
      output.push(record);
    }
    return { runId, tools: output };
  } finally { db.close(); }
}
