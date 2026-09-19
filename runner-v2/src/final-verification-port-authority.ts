import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface FinalVerificationPortLease {
  version: 1;
  runId: string;
  targetRevision: string;
  port: number;
  leaseId: string;
}

/** Runner-owned cross-run reservation for exact-profile application ports. */
export class FinalVerificationPortAuthority {
  private readonly activeDirectory: string;
  private readonly archiveDirectory: string;

  constructor(stateDirectory: string) {
    const root = resolve(stateDirectory, "final-verification-ports");
    this.activeDirectory = join(root, "active");
    this.archiveDirectory = join(root, "archive");
  }

  async reserve(runId: string, targetRevision: string): Promise<FinalVerificationPortLease> {
    return (await this.reserveDetailed(runId, targetRevision)).lease;
  }

  async reserveDetailed(runId: string, targetRevision: string): Promise<{
    lease: FinalVerificationPortLease;
    created: boolean;
  }> {
    if (!runId.trim() || !isRevision(targetRevision)) {
      throw new Error("Final verification port reservation requires an exact run and revision.");
    }
    await mkdir(this.activeDirectory, { recursive: true });
    await mkdir(this.archiveDirectory, { recursive: true });
    const existing = await this.findRunLease(runId, targetRevision);
    if (existing) return { lease: existing, created: false };

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const reservation = await bindEphemeralPort();
      const lease: FinalVerificationPortLease = {
        version: 1,
        runId,
        targetRevision,
        port: reservation.port,
        leaseId: randomUUID(),
      };
      const path = this.activePathFor(lease.port);
      let activeWritten = false;
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(lease)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        activeWritten = true;
        await writeFile(this.archivePathFor(lease.leaseId), `${JSON.stringify(lease)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        await reservation.release();
        return { lease, created: true };
      } catch (error) {
        await reservation.release();
        if (activeWritten) await rm(path, { force: true }).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error("Runner could not reserve an isolated final verification port.");
  }

  async validate(lease: unknown, runId: string, targetRevision: string): Promise<void> {
    const expected = assertLease(lease, runId, targetRevision);
    let durable: unknown;
    try {
      durable = JSON.parse(await readFile(this.activePathFor(expected.port), "utf8")) as unknown;
    } catch (error) {
      throw new Error("Runner-owned final verification port lease is missing or invalid.", { cause: error });
    }
    const actual = assertLease(durable, runId, targetRevision);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error("Runner-owned final verification port lease conflicts with the execution profile.");
    }
  }

  validateDurable(lease: unknown, runId: string, targetRevision: string): void {
    const expected = assertLease(lease, runId, targetRevision);
    let durable: unknown;
    try {
      durable = JSON.parse(readFileSync(this.archivePathFor(expected.leaseId), "utf8")) as unknown;
    } catch (error) {
      throw new Error("Runner-owned final verification port lease archive is missing or invalid.", { cause: error });
    }
    const actual = assertLease(durable, runId, targetRevision);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error("Runner-owned final verification port lease archive conflicts with the execution profile.");
    }
  }

  async release(lease: unknown, runId: string, targetRevision: string): Promise<void> {
    const expected = assertLease(lease, runId, targetRevision);
    this.validateDurable(expected, runId, targetRevision);
    try {
      await this.validate(expected, runId, targetRevision);
    } catch (error) {
      if (error instanceof Error && /lease is missing or invalid/i.test(error.message)) return;
      throw error;
    }
    await rm(this.activePathFor(expected.port), { force: true });
  }

  async releaseRun(runId: string): Promise<void> {
    await mkdir(this.activeDirectory, { recursive: true });
    for (const name of await readdir(this.activeDirectory)) {
      if (!/^\d+\.json$/.test(name)) continue;
      const path = join(this.activeDirectory, name);
      let lease: unknown;
      try { lease = JSON.parse(await readFile(path, "utf8")) as unknown; }
      catch { continue; }
      if (lease && typeof lease === "object" && !Array.isArray(lease) &&
        (lease as Record<string, unknown>).runId === runId) {
        await rm(path, { force: true });
      }
    }
  }

  private async findRunLease(
    runId: string,
    targetRevision: string,
  ): Promise<FinalVerificationPortLease | undefined> {
    for (const name of await readdir(this.activeDirectory)) {
      if (!/^\d+\.json$/.test(name)) continue;
      try {
        const value = JSON.parse(await readFile(join(this.activeDirectory, name), "utf8")) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value) &&
          (value as Record<string, unknown>).runId === runId &&
          (value as Record<string, unknown>).targetRevision === targetRevision) {
          return assertLease(value, runId, targetRevision);
        }
      } catch (error) {
        throw new Error("Runner-owned active final verification port registry is invalid.", { cause: error });
      }
    }
    return undefined;
  }

  private activePathFor(port: number): string {
    if (!validPort(port)) throw new Error("Final verification port lease has an invalid port.");
    return join(this.activeDirectory, `${port}.json`);
  }

  private archivePathFor(leaseId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leaseId)) {
      throw new Error("Final verification port lease ID is invalid.");
    }
    return join(this.archiveDirectory, `${leaseId}.json`);
  }
}

function assertLease(
  value: unknown,
  runId: string,
  targetRevision: string,
): FinalVerificationPortLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Final verification port lease is invalid.");
  }
  const lease = value as Partial<FinalVerificationPortLease>;
  if (lease.version !== 1 || lease.runId !== runId || lease.targetRevision !== targetRevision ||
    !validPort(lease.port) || typeof lease.leaseId !== "string" || !validLeaseId(lease.leaseId)) {
    throw new Error("Final verification port lease is stale or invalid.");
  }
  return { ...lease } as FinalVerificationPortLease;
}

async function bindEphemeralPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Runner could not inspect its final verification port reservation.");
  }
  let released = false;
  return {
    port: address.port,
    release: async () => {
      if (released) return;
      released = true;
      await closeServer(server);
    },
  };
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

function validPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1_024 && (value as number) <= 65_535;
}

function validLeaseId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRevision(value: string): boolean {
  return /^[a-f0-9]{40,64}$/.test(value);
}
