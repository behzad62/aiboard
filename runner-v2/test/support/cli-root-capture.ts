import type { Readable } from "node:stream";
import { createInterface } from "node:readline";

export function cliRootCaptureArgs(
  args: readonly string[],
  enabled = process.env.AIBOARD_C5_CAPTURE_ROOTS === "1",
  launcher: "node" | "tsx" = "node",
): string[] {
  if (!enabled) return [...args];
  const observer = ["--import", new URL("./cli-root-observer.mjs", import.meta.url).href];
  if (launcher === "tsx") {
    const [tsxPath, ...childArgs] = args;
    if (!tsxPath) throw new Error("The tsx observer requires the exact launcher path.");
    // tsx does not inherit its wrapper's execArgv. Its explicit child arguments
    // must carry the observer; do not copy arbitrary flags or use NODE_OPTIONS.
    return [tsxPath, ...observer, ...childArgs];
  }
  return [...observer, ...args];
}
export function forwardCliRootRecords(stderr: Readable, emit: (record: string) => void = (record) => process.stderr.write(record)): void {
  const lines = createInterface({ input: stderr });
  lines.on("line", (line) => {
    const prefix = "C5 CLI root: ";
    if (!line.startsWith(prefix)) return;
    try {
      const record = JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
      if (!record || typeof record !== "object" || Array.isArray(record) ||
          typeof record.path !== "string" || record.path.length === 0 || /[\r\n\0]/.test(record.path)) return;
      const keys = Object.keys(record).sort().join(",");
      if ((record.event === "created" && keys === "event,path") ||
          (record.event === "exit" && keys === "event,existsAtExit,path" && typeof record.existsAtExit === "boolean")) {
        emit(`${prefix}${JSON.stringify(record)}\n`);
      }
    } catch { /* Non-observer stderr stays in the existing private diagnostics. */ }
  });
}
