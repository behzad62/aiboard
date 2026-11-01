import { RUNNER_INSTALL_POSIX, RUNNER_INSTALL_WINDOWS } from "@/lib/runner-install";

/** The two one-line installers, labelled by system. Shared by the Runner guide and Build setup. */
export function RunnerInstallCommands({ compact = false }: { compact?: boolean }) {
  const pre = compact
    ? "overflow-x-auto rounded-md bg-background/70 p-2 text-xs"
    : "overflow-x-auto rounded-lg border bg-muted p-4 text-sm";
  const label = compact ? "text-xs text-muted-foreground" : "text-sm font-medium";
  return (
    <div className="space-y-2">
      <p className={label}>Windows (PowerShell)</p>
      <pre className={pre}>{RUNNER_INSTALL_WINDOWS}</pre>
      <p className={label}>macOS / Linux</p>
      <pre className={pre}>{RUNNER_INSTALL_POSIX}</pre>
    </div>
  );
}
