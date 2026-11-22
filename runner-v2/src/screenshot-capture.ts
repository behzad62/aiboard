import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import type { ExecutionHost } from "./execution-host.js";
import type { ToolExecutionContext } from "./agent-contracts.js";
import { createBoundedGitCommandExecutor, GitCommandExecutionError } from "./git-preflight.js";
import { probeImage } from "./image-inspection.js";

export const MAX_TRANSFER_IMAGE_BYTES = 20 * 1024 * 1024;
const coordinate = z.number().int().min(-100_000).max(100_000);
export const screenshotSchema = z.discriminatedUnion("target", [
  z.object({ target: z.literal("monitor"), monitor: z.number().int().min(0).max(63).optional(), format: z.literal("png").optional(), resize: z.literal(false).optional() }).strict(),
  z.object({ target: z.literal("window"), windowTitle: z.string().min(1).max(256), format: z.literal("png").optional(), resize: z.literal(false).optional() }).strict(),
  z.object({ target: z.literal("region"), x: coordinate, y: coordinate, width: z.number().int().min(1).max(20_000),
    height: z.number().int().min(1).max(20_000), format: z.literal("png").optional(), resize: z.literal(false).optional() }).strict(),
]);

export async function captureDesktopScreenshot(host: ExecutionHost, input: z.infer<typeof screenshotSchema>, signal?: AbortSignal,
  control?: ToolExecutionContext["screenshot"]): Promise<Buffer> {
  if (process.platform !== "win32") throw new Error("Desktop screenshot capture requires an interactive Windows session.");
  signal?.throwIfAborted();
  const environment = host.filteredEnvironmentSource();
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = fileURLToPath(new URL("./screenshot-capture.ps1", import.meta.url));
  const encoded = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
  let inputSupplied = false;
  const stopped = () => control?.stopped?.(inputSupplied ? "effect_outcome_unknown" : "no_effect");
  const run = createBoundedGitCommandExecutor({ executionDeadlineMs: 30_000, terminationDeadlineMs: 15_000,
    environment, processKernel: host.internalProcesses, signal,
    maxOutputBytes: Math.ceil(MAX_TRANSFER_IMAGE_BYTES / 3) * 4 + 4096,
    stdin: () => {
      if (signal?.aborted || (control && !control.authorize())) return undefined;
      inputSupplied = true;
      return Buffer.from(encoded + "\n");
    },
  });
  const answer = await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]).catch((error) => {
    if (error instanceof GitCommandExecutionError && error.cleanupVerified) stopped();
    throw error;
  });
  stopped();
  signal?.throwIfAborted();
  if (answer.exitCode !== 0) {
    const reason = answer.stderr.trim().match(/^AIBOARD_CAPTURE: ([^\r\n]{1,256})$/m)?.[1];
    throw new Error(reason ?? "Windows could not capture the requested desktop area.");
  }
  const bytes = Buffer.from(answer.stdout.trim(), "base64");
  if (bytes.byteLength > MAX_TRANSFER_IMAGE_BYTES || probeImage(bytes).mediaType !== "image/png") throw new Error("Invalid screenshot PNG.");
  return bytes;
}
