import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/**
 * Trusted local discovery of the always-denied file-tool locations (ADR-D).
 * This module is a pure function of (platform, env, home, configured dirs):
 * it never reads tool input and never touches the filesystem, so tests can
 * classify every OS from any host. Runtime callers resolve it once at Runner
 * startup from local configuration; if a required location cannot be
 * determined the result is `failClosed` and remote file tools must refuse.
 */

export type ProtectedCategory =
  | "runner_state"
  | "aiboard_data"
  | "device_key"
  | "extension_secret"
  | "installer_bin"
  | "ssh"
  | "os_credential_store"
  | "browser_profile"
  | "cloud_credentials"
  | "pseudo_filesystem"
  | "configured";

export interface ProtectedLocation {
  readonly path: string;
  readonly category: ProtectedCategory;
  /** `file` protects exactly that object; `directory` protects it and descendants. */
  readonly kind: "directory" | "file";
}

export interface ProtectedLocations {
  readonly platform: NodeJS.Platform;
  readonly locations: readonly ProtectedLocation[];
  /** True when a required location could not be determined from trusted config. */
  readonly failClosed: boolean;
  readonly failures: readonly string[];
}

export interface ProtectedLocationsInput {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly uid?: number;
  /** The actual configured Runner `--state-dir`. */
  readonly stateDirectory?: string;
  /** Per-user remote device custody directory (holds the device key). */
  readonly deviceDirectory?: string;
  /** Per-user AIBoard data root override; derived from platform/env/home otherwise. */
  readonly dataRoot?: string;
  /** Extension credential/secret directories from trusted local configuration. */
  readonly extensionDirectories?: readonly string[];
  /** Actual installer bin directories; the planned per-OS bin is added when absent. */
  readonly installerBinDirectories?: readonly string[];
  /** Extra trusted local directories (e.g. an explicitly configured secret store). */
  readonly configuredDirectories?: readonly string[];
  /** Explicit Runner-owned files such as the capabilities configuration. */
  readonly configuredFiles?: readonly string[];
  /** Production composition sets this: the configured state dir is not optional there. */
  readonly requireStateDirectory?: boolean;
}

export function resolveProtectedLocations(input: ProtectedLocationsInput = {}): ProtectedLocations {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const paths = platform === "win32" ? win32 : posix;
  const home = input.home ?? defaultHome(platform, env);
  const failures: string[] = [];
  const locations: ProtectedLocation[] = [];
  const seen = new Set<string>();
  const keyOf = (value: string) => (platform === "win32" || platform === "darwin" ? value.toLowerCase() : value);
  const add = (value: string | undefined, category: ProtectedCategory, kind: "directory" | "file" = "directory") => {
    if (!value) return;
    const normalized = paths.resolve(value);
    const key = `${kind}:${keyOf(normalized)}`;
    if (seen.has(key)) return;
    seen.add(key);
    locations.push(Object.freeze({ path: normalized, category, kind }));
  };
  const requireHome = () => {
    if (!home || !paths.isAbsolute(home)) failures.push("home directory could not be determined");
    return home && paths.isAbsolute(home) ? home : undefined;
  };
  const envAbsolute = (name: string): string | undefined => {
    const value = env[name];
    if (!value) { failures.push(`${name} is not set`); return undefined; }
    if (!paths.isAbsolute(value)) { failures.push(`${name} is not an absolute path`); return undefined; }
    return value;
  };

  const homeDir = requireHome();

  // Runner-owned custody: the configured state dir, the per-user data root
  // (every project's state plus the device key), and extension secrets.
  if (input.stateDirectory) {
    if (paths.isAbsolute(input.stateDirectory)) add(input.stateDirectory, "runner_state");
    else failures.push("configured state directory is not an absolute path");
  } else if (input.requireStateDirectory) {
    failures.push("configured state directory was not supplied");
  }
  let dataRoot = input.dataRoot;
  if (!dataRoot) {
    if (platform === "win32") {
      const local = env.LOCALAPPDATA && paths.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : undefined;
      if (local) dataRoot = paths.join(local, "AIBoard");
    } else if (platform === "darwin") {
      if (homeDir) dataRoot = paths.join(homeDir, "Library", "Application Support", "AIBoard");
    } else {
      const xdg = env.XDG_DATA_HOME && paths.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : undefined;
      if (xdg) dataRoot = paths.join(xdg, "aiboard");
      else if (homeDir) dataRoot = paths.join(homeDir, ".local", "share", "aiboard");
    }
  }
  if (dataRoot && paths.isAbsolute(dataRoot)) add(dataRoot, "aiboard_data");
  else if (!dataRoot) failures.push("per-user AIBoard data root could not be determined");
  if (input.deviceDirectory) {
    if (paths.isAbsolute(input.deviceDirectory)) add(input.deviceDirectory, "device_key");
    else failures.push("remote device directory is not an absolute path");
  } else if (dataRoot && paths.isAbsolute(dataRoot)) {
    add(paths.join(dataRoot, "remote"), "device_key");
  }
  for (const dir of input.extensionDirectories ?? []) {
    if (paths.isAbsolute(dir)) add(dir, "extension_secret");
    else failures.push("extension directory is not an absolute path");
  }

  // Planned installer bin (ADR-D) plus any actual configured installer bin.
  const plannedBin = platform === "win32"
    ? (env.LOCALAPPDATA && paths.isAbsolute(env.LOCALAPPDATA) ? paths.join(env.LOCALAPPDATA, "AIBoard", "bin") : undefined)
    : (homeDir ? paths.join(homeDir, ".aiboard", "bin") : undefined);
  if (plannedBin) add(plannedBin, "installer_bin");
  else if (platform === "win32") failures.push("installer bin could not be determined (LOCALAPPDATA)");
  // L2 installs program files, shims and the version pointers under ~/.aiboard on macOS/Linux
  // (on Windows they live inside the already protected data root).
  if (platform !== "win32" && homeDir) add(paths.join(homeDir, ".aiboard"), "installer_bin");
  for (const dir of input.installerBinDirectories ?? []) {
    if (paths.isAbsolute(dir)) add(dir, "installer_bin");
    else failures.push("installer bin directory is not an absolute path");
  }
  for (const dir of input.configuredDirectories ?? []) {
    if (paths.isAbsolute(dir)) add(dir, "configured");
    else failures.push("configured protected directory is not an absolute path");
  }
  for (const file of input.configuredFiles ?? []) {
    if (paths.isAbsolute(file)) add(file, "configured", "file");
    else failures.push("configured protected file is not an absolute path");
  }

  if (homeDir) add(paths.join(homeDir, ".ssh"), "ssh");

  if (platform === "win32") {
    const appData = envAbsolute("APPDATA");
    const localAppData = envAbsolute("LOCALAPPDATA");
    const userProfile = env.USERPROFILE && paths.isAbsolute(env.USERPROFILE) ? env.USERPROFILE : homeDir;
    if (appData) {
      add(paths.join(appData, "Microsoft", "Credentials"), "os_credential_store");
      add(paths.join(appData, "Microsoft", "Protect"), "os_credential_store");
      add(paths.join(appData, "Mozilla", "Firefox", "Profiles"), "browser_profile");
      add(paths.join(appData, "gcloud"), "cloud_credentials");
      add(paths.join(appData, "GitHub CLI", "hosts.yml"), "cloud_credentials", "file");
    }
    if (localAppData) {
      add(paths.join(localAppData, "Microsoft", "Credentials"), "os_credential_store");
      add(paths.join(localAppData, "Microsoft", "Vault"), "os_credential_store");
      add(paths.join(localAppData, "Google", "Chrome", "User Data"), "browser_profile");
      add(paths.join(localAppData, "Microsoft", "Edge", "User Data"), "browser_profile");
      add(paths.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"), "browser_profile");
    }
    if (userProfile) {
      add(paths.join(userProfile, ".aws"), "cloud_credentials");
      add(paths.join(userProfile, ".azure"), "cloud_credentials");
      add(paths.join(userProfile, ".kube"), "cloud_credentials");
      add(paths.join(userProfile, ".docker", "config.json"), "cloud_credentials", "file");
    }
  } else if (platform === "darwin") {
    if (homeDir) {
      add(paths.join(homeDir, "Library", "Keychains"), "os_credential_store");
      add(paths.join(homeDir, ".gnupg"), "os_credential_store");
      add(paths.join(homeDir, "Library", "Application Support", "Google", "Chrome"), "browser_profile");
      add(paths.join(homeDir, "Library", "Application Support", "Microsoft Edge"), "browser_profile");
      add(paths.join(homeDir, "Library", "Application Support", "BraveSoftware", "Brave-Browser"), "browser_profile");
      add(paths.join(homeDir, "Library", "Application Support", "Firefox", "Profiles"), "browser_profile");
      add(paths.join(homeDir, "Library", "Safari"), "browser_profile");
      add(paths.join(homeDir, ".aws"), "cloud_credentials");
      add(paths.join(homeDir, ".azure"), "cloud_credentials");
      add(paths.join(homeDir, ".config", "gcloud"), "cloud_credentials");
      add(paths.join(homeDir, ".kube"), "cloud_credentials");
      add(paths.join(homeDir, ".docker", "config.json"), "cloud_credentials", "file");
      add(paths.join(homeDir, ".config", "gh", "hosts.yml"), "cloud_credentials", "file");
    }
    add("/Library/Keychains", "os_credential_store");
  } else {
    if (homeDir) {
      add(paths.join(homeDir, ".local", "share", "keyrings"), "os_credential_store");
      add(paths.join(homeDir, ".gnupg"), "os_credential_store");
      add(paths.join(homeDir, ".config", "google-chrome"), "browser_profile");
      add(paths.join(homeDir, ".config", "chromium"), "browser_profile");
      add(paths.join(homeDir, ".config", "BraveSoftware", "Brave-Browser"), "browser_profile");
      add(paths.join(homeDir, ".mozilla", "firefox"), "browser_profile");
      add(paths.join(homeDir, ".aws"), "cloud_credentials");
      add(paths.join(homeDir, ".azure"), "cloud_credentials");
      add(paths.join(homeDir, ".config", "gcloud"), "cloud_credentials");
      add(paths.join(homeDir, ".kube"), "cloud_credentials");
      add(paths.join(homeDir, ".docker", "config.json"), "cloud_credentials", "file");
      add(paths.join(homeDir, ".config", "gh", "hosts.yml"), "cloud_credentials", "file");
    }
    const xdgData = env.XDG_DATA_HOME && paths.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : undefined;
    if (xdgData) add(paths.join(xdgData, "keyrings"), "os_credential_store");
    const uid = input.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    if (uid !== undefined && Number.isSafeInteger(uid) && uid >= 0) add(paths.join("/run/user", String(uid), "keyring"), "os_credential_store");
    else failures.push("user keyring location could not be determined (uid)");
    add("/etc/shadow", "os_credential_store", "file");
    add("/etc/gshadow", "os_credential_store", "file");
    add("/etc/ssl/private", "os_credential_store");
    add("/proc", "pseudo_filesystem");
    add("/sys", "pseudo_filesystem");
    add("/dev", "pseudo_filesystem");
  }

  // Cloud CLI credential locations relocated through trusted local environment.
  const relocatedFile = (name: string) => {
    const value = env[name];
    if (!value) return;
    if (paths.isAbsolute(value)) add(value, "cloud_credentials", "file");
    else failures.push(`${name} is not an absolute path`);
  };
  const relocatedDir = (name: string) => {
    const value = env[name];
    if (!value) return;
    if (paths.isAbsolute(value)) add(value, "cloud_credentials");
    else failures.push(`${name} is not an absolute path`);
  };
  relocatedFile("AWS_CONFIG_FILE");
  relocatedFile("AWS_SHARED_CREDENTIALS_FILE");
  relocatedDir("AZURE_CONFIG_DIR");
  relocatedDir("CLOUDSDK_CONFIG");
  relocatedDir("DOCKER_CONFIG");
  relocatedDir("GH_CONFIG_DIR");
  const kubeconfig = env.KUBECONFIG;
  if (kubeconfig) {
    for (const entry of kubeconfig.split(platform === "win32" ? ";" : ":")) {
      if (!entry) continue;
      if (paths.isAbsolute(entry)) add(entry, "cloud_credentials", "file");
      else failures.push("KUBECONFIG entry is not an absolute path");
    }
  }

  return Object.freeze({
    platform,
    locations: Object.freeze(locations),
    failClosed: failures.length > 0,
    failures: Object.freeze(failures),
  });
}

function defaultHome(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
  if (platform === "win32") return env.USERPROFILE && win32.isAbsolute(env.USERPROFILE) ? env.USERPROFILE : homedir();
  return env.HOME && posix.isAbsolute(env.HOME) ? env.HOME : homedir();
}
