import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Reads the OS machine id; resolves undefined when none is readable. */
export type MachineIdReader = () => Promise<string | undefined>;

const TIMEOUT_MS = 5_000;

/**
 * Keyed hash of the machine id that the relay uses only to share the free
 * allowance per computer. Keying by the relay origin means the raw id never
 * leaves the computer and hints cannot be linked across relays.
 */
export function machineHint(origin: string, machineId: string): string {
  return createHmac("sha256", Buffer.from(origin, "utf8")).update(machineId.trim().toLowerCase(), "utf8").digest("base64url");
}

/** The id must look like a GUID or a 128-bit hex id; all-zero placeholders (some VMs and containers) are ignored. */
export function plausibleMachineId(value: string | undefined): string | undefined {
  const id = value?.trim().toLowerCase();
  if (!id || !/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/.test(id) || /^[0-]+$/.test(id)) return undefined;
  return id;
}

function run(file: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout) => resolve(error ? undefined : String(stdout)));
    } catch { resolve(undefined); }
  });
}

/** Windows MachineGuid, Linux /etc/machine-id (or the dbus copy), macOS IOPlatformUUID. Never throws. */
export async function readMachineId(platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  try {
    if (platform === "win32") {
      const reg = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
      const output = await run(reg, ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"]);
      return plausibleMachineId(/MachineGuid\s+REG_SZ\s+(\S+)/i.exec(output ?? "")?.[1]);
    }
    if (platform === "linux") {
      for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        const id = plausibleMachineId(await readFile(path, "utf8").catch(() => undefined));
        if (id) return id;
      }
      return undefined;
    }
    if (platform === "darwin") {
      const output = await run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
      return plausibleMachineId(/"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output ?? "")?.[1]);
    }
  } catch { /* An unreadable id only means no hint is sent. */ }
  return undefined;
}
