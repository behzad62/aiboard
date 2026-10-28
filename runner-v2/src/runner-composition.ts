import { join } from "node:path";

import type { PermissionProfile } from "./contracts.js";
import type { ExecutionHost } from "./execution-host.js";
import {
  createRemoteAdmissionAdapter,
  RemoteAdmissionStore,
} from "./remote-admission-store.js";
import { RemoteAuthenticator } from "./remote-auth.js";
import { RemoteDeviceStore } from "./remote-device-store.js";
import { RemotePrincipalStore } from "./remote-principal.js";
import { RemoteToolRuntime } from "./remote-tool-runtime.js";
import type { RunnerCapabilitiesConfig } from "./runner-capabilities-config.js";
import { FileStorageKeyProvider } from "./storage-key.js";

export interface RemoteComposition {
  readonly deviceStore: RemoteDeviceStore;
  readonly principals: RemotePrincipalStore;
  readonly admission: RemoteAdmissionStore;
  readonly runtime: RemoteToolRuntime;
  readonly authenticator: RemoteAuthenticator;
}

export interface RemoteCompositionOptions {
  readonly stateDirectory: string;
  /** Per-user device custody directory (launcher-instance remoteDeviceDirectory); never the project state. */
  readonly deviceDirectory: string;
  readonly workspacePath: string;
  readonly host: ExecutionHost;
  readonly permissionProfile: PermissionProfile;
  readonly capabilitiesConfig: RunnerCapabilitiesConfig;
  readonly extensionsHome?: string;
  readonly now?: () => Date;
}

/**
 * Composition seam shared by the CLI and tests: one ExecutionHost and one
 * admission store serve both local and remote broker dispatch. The admission
 * key comes from the project storage key; the device key never does.
 */
export function composeRemoteRuntime(options: RemoteCompositionOptions): RemoteComposition {
  const deviceStore = new RemoteDeviceStore(options.deviceDirectory);
  const principals = new RemotePrincipalStore(join(options.stateDirectory, "remote-principals.sqlite"), undefined,
    join(options.deviceDirectory, "remote-device-policy.sqlite"));
  const storageKey = new FileStorageKeyProvider(options.stateDirectory).getKey({ createIfMissing: true });
  let admission: RemoteAdmissionStore;
  try {
    admission = new RemoteAdmissionStore(join(options.stateDirectory, "remote-admission.sqlite"), storageKey, options.now);
  } finally {
    storageKey.fill(0);
  }
  const runtime = new RemoteToolRuntime({
    host: options.host,
    principals,
    workspacePath: options.workspacePath,
    permissionProfile: options.permissionProfile,
    capabilitiesConfig: options.capabilitiesConfig,
    admitEffect: createRemoteAdmissionAdapter(admission),
    stateDirectory: options.stateDirectory,
    deviceDirectory: options.deviceDirectory,
    ...(options.extensionsHome ? { extensionDirectories: [options.extensionsHome] } : {}),
  });
  const authenticator = new RemoteAuthenticator(deviceStore, options.now ? { now: options.now } : {});
  return { deviceStore, principals, admission, runtime, authenticator };
}

export async function closeRemoteComposition(composition: RemoteComposition): Promise<void> {
  const failures: unknown[] = [];
  try { await composition.runtime.close(); } catch (error) { failures.push(error); }
  try { composition.admission.close(); } catch (error) { failures.push(error); }
  try { composition.principals.close(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Remote composition cleanup remains unverified.");
}
