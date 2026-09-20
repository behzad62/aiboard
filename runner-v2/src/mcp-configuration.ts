import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { types } from "node:util";
import {
  freezeExecutionLifecycleRequirements,
  type ExecutionLifecycleRequirements,
} from "./execution-lifecycle-policy.js";

export interface McpDeclaredEnvelope {
  readonly paths?: readonly Readonly<{ path: string; mode: "read" | "write" }>[];
  readonly network?: boolean;
  readonly credentialNames?: readonly string[];
}
export interface McpServerSpec {
  name: string;
  command: string;
  /** Fixed configuration authority, never derived from model tool arguments. */
  envelope?: McpDeclaredEnvelope;
  /** Trusted lifecycle requirements; never inferred from model text. */
  lifecycleRequirements?: ExecutionLifecycleRequirements;
}
export interface McpFixedEnvelope {
  readonly paths: readonly Readonly<{ path: string; mode: "read" | "write" }>[];
  readonly network: boolean;
  readonly credentialNames: readonly string[];
}
export type McpConfigurationErrorCode = "mcp_command_invalid" | "mcp_envelope_invalid" | "mcp_executable_unavailable" | "mcp_attestation_mismatch";
export class McpConfigurationError extends Error {
  constructor(readonly code: McpConfigurationErrorCode, message: string) { super(message); this.name = "McpConfigurationError"; }
}

/** Closed argv grammar shared on Windows/POSIX. Quotes enclose an entire token;
 * shell expansion, quote concatenation and ambiguous escape rules are refused.
 * Literal metacharacters inside a quoted argument remain ordinary argument data.
 */
export function parseMcpCommand(command: string): readonly string[] {
  const invalid = () => new McpConfigurationError("mcp_command_invalid", "MCP command requires an exact executable and unambiguous quoted arguments, without shell evaluation.");
  if (typeof command !== "string" || !command.trim() || Buffer.byteLength(command) > 64 * 1024 || /[\0\r\n]/u.test(command)) throw invalid();
  const result: string[] = [];
  for (let cursor = 0; cursor < command.length;) {
    while (command[cursor] === " " || command[cursor] === "\t") cursor++;
    if (cursor >= command.length) break;
    let token = "";
    if (command[cursor] === '"' || command[cursor] === "'") {
      const quote = command[cursor++]!;
      let closed = false;
      while (cursor < command.length) {
        const character = command[cursor++]!;
        if (character === quote) { closed = true; break; }
        if (quote === '"' && character === "\\" && command[cursor] === '"') throw invalid();
        token += character;
      }
      if (!closed || cursor < command.length && command[cursor] !== " " && command[cursor] !== "\t") throw invalid();
    } else {
      while (cursor < command.length && command[cursor] !== " " && command[cursor] !== "\t") {
        const character = command[cursor++]!;
        if (/[&|;<>`$()%*?'"\[\]{}]/u.test(character)) throw invalid();
        token += character;
      }
    }
    result.push(token);
    if (result.length > 256) throw invalid();
  }
  if (!result[0] || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(result[0])) throw invalid();
  return Object.freeze(result);
}

export function fixedMcpEnvelope(value: McpDeclaredEnvelope | undefined): McpFixedEnvelope {
  const error = () => new McpConfigurationError("mcp_envelope_invalid", "MCP requires a bounded conservative fixed path, network and credential envelope.");
  const object = value === undefined ? {} : plainData(value, ["paths", "network", "credentialNames"], error);
  const paths = boundedDataArray(object.paths, 64, error);
  const credentials = boundedDataArray(object.credentialNames, 64, error);
  if (object.network !== undefined && typeof object.network !== "boolean") throw error();
  const seen = new Set<string>();
  const fixed = paths.map((value) => {
    const entry = plainData(value, ["path", "mode"], error);
    if (typeof entry.path !== "string" || !entry.path || entry.path !== entry.path.trim() || Buffer.byteLength(entry.path) > 4096 || /[\0\r\n]/u.test(entry.path) ||
        entry.mode !== "read" && entry.mode !== "write") throw error();
    if (!isAbsolute(entry.path) && entry.path.split(/[\\/]/u).includes("..")) throw error();
    const key = entry.path.replaceAll("\\", "/");
    if (seen.has(key)) throw error(); seen.add(key);
    return Object.freeze({ path: entry.path, mode: entry.mode });
  });
  const names = new Set<string>();
  for (const name of credentials) {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) || names.has(name)) throw error();
    names.add(name);
  }
  return Object.freeze({ paths: Object.freeze(fixed), network: object.network === true, credentialNames: Object.freeze([...names].sort()) });
}

export function snapshotMcpServerSpec(value: McpServerSpec): Readonly<McpServerSpec> {
  const error = () => new McpConfigurationError("mcp_command_invalid", "MCP server configuration is invalid.");
  const object = plainData(value, ["name", "command", "envelope", "lifecycleRequirements"], error);
  if (typeof object.name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/u.test(object.name) || typeof object.command !== "string") throw error();
  parseMcpCommand(object.command);
  const envelope = fixedMcpEnvelope(object.envelope as McpDeclaredEnvelope | undefined);
  const lifecycleRequirements = fixedMcpLifecycleRequirements(object.lifecycleRequirements);
  return Object.freeze({
    name: object.name,
    command: object.command,
    envelope,
    ...(lifecycleRequirements ? { lifecycleRequirements } : {}),
  });
}

/** Reject unknown/non-plain lifecycle shapes; canonicalize true flags through shared freeze. */
function fixedMcpLifecycleRequirements(value: unknown): ExecutionLifecycleRequirements | undefined {
  if (value === undefined) return undefined;
  const error = () => new McpConfigurationError("mcp_command_invalid", "MCP server configuration is invalid.");
  const object = plainData(value, ["requireCompleteCleanup", "knownUnavoidableDetachment"], error);
  if (object.requireCompleteCleanup !== undefined && typeof object.requireCompleteCleanup !== "boolean") throw error();
  if (object.knownUnavoidableDetachment !== undefined && typeof object.knownUnavoidableDetachment !== "boolean") throw error();
  return freezeExecutionLifecycleRequirements({
    ...(typeof object.requireCompleteCleanup === "boolean"
      ? { requireCompleteCleanup: object.requireCompleteCleanup }
      : {}),
    ...(typeof object.knownUnavoidableDetachment === "boolean"
      ? { knownUnavoidableDetachment: object.knownUnavoidableDetachment }
      : {}),
  });
}

export function mcpConfigurationDigest(value: McpServerSpec): string {
  const fixed = snapshotMcpServerSpec(value);
  return canonicalMcpDigest(fixed);
}
export function canonicalMcpDigest(value: unknown): string {
  const canonical = (entry: unknown): string => {
    if (entry === null || typeof entry !== "object") return JSON.stringify(entry);
    if (Array.isArray(entry)) return `[${entry.map(canonical).join(",")}]`;
    return `{${Object.entries(entry).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(",")}}`;
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function plainData(value: unknown, keys: readonly string[], error: () => Error): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key)) ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw error();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}


/** Repeated --mcp-envelope declarations configure an existing exact server name.
 * The CLI cannot silently create another server or merge incompatible authority.
 */
export function configureMcpServers(servers: readonly McpServerSpec[], declarations: readonly string[]): readonly McpServerSpec[] {
  const error = () => new McpConfigurationError("mcp_envelope_invalid", "MCP envelope declarations require one bounded JSON object per configured server.");
  if (servers.length > 128 || declarations.length > 128) throw new McpConfigurationError("mcp_envelope_invalid", "MCP server configuration exceeds its count bound.");
  const byName = new Map<string, Readonly<McpServerSpec>>();
  for (const server of servers) {
    const configured = snapshotMcpServerSpec(server);
    if (byName.has(configured.name)) throw new McpConfigurationError("mcp_envelope_invalid", "MCP server configuration has a duplicate name.");
    byName.set(configured.name, configured);
  }
  const declared = new Set<string>();
  for (const declaration of declarations) {
    if (typeof declaration !== "string" || Buffer.byteLength(declaration) > 64 * 1024) throw error();
    const split = declaration.indexOf("=");
    if (split < 1) throw error();
    const name = declaration.slice(0, split); const original = byName.get(name);
    if (!original || declared.has(name)) throw error();
    declared.add(name);
    let envelope: unknown;
    try { envelope = JSON.parse(declaration.slice(split + 1)); } catch { throw error(); }
    byName.set(name, snapshotMcpServerSpec({ ...original, envelope: fixedMcpEnvelope(envelope as McpDeclaredEnvelope) }));
  }
  return Object.freeze([...byName.values()]);
}
function boundedDataArray(value: unknown, maximum: number, error: () => Error): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum || Reflect.ownKeys(descriptors).some((key) =>
    typeof key !== "string" || key !== "length" && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length))) throw error();
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) throw error();
    return descriptor.value;
  });
}
