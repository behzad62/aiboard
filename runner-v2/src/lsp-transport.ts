import type { LanguageInvocationContext } from "./language-intelligence.js";
import type { LanguageServerExecutableIdentity } from "./language-server-executable.js";

/** Family protocol only. The implementation owns no OS identity or signal. */
export interface LspProtocolWriter { write(payload: Uint8Array, timeoutMs: number): Promise<void> }
export interface LspTransportOpenRequest {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly workspaceRoot: string;
  readonly attestedCommand?: LanguageServerExecutableIdentity;
  readonly explicitEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly invocation: LanguageInvocationContext;
  readonly initialize: (writer: LspProtocolWriter) => Promise<string>;
  readonly onOutput: (stream: "stdout" | "stderr", bytes: Uint8Array) => void | Promise<void>;
  readonly onFailure: (error: Error) => void;
}
export interface LspOwnedTransport {
  withInvocation<T>(invocation: LanguageInvocationContext, operation: (writer: LspProtocolWriter) => Promise<T>, timeoutMs: number): Promise<T>;
  closeVerified(shutdown?: (writer: LspProtocolWriter) => Promise<void>, timeoutMs?: number): Promise<void>;
}
export interface LspTransportFactory {
  open(request: LspTransportOpenRequest): Promise<LspOwnedTransport>;
}
