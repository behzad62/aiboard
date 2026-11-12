/**
 * The only place that builds a provider SDK client or sends a raw provider
 * request (HM4a, plan §9 "Browser side: one resolver").
 *
 * Every client is built from a connection that `resolveProviderConnection`
 * (lib/client/providers.ts) returned: the Runner's model proxy, which adds the
 * real key from the AIBoard home, or for ChatGPT and Copilot the account
 * peer's address and token from the launcher. A client never falls back to a
 * provider's own host, so a proxy token can never reach a third party.
 * scripts/test-no-direct-provider-calls.mts fails on any SDK client or
 * provider fetch built anywhere else.
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";

/** The path prefix every model-proxy base URL carries (runner-v2/src/model-proxy.ts). */
export const MODEL_PROXY_PATH_PREFIX = "/v2/model-proxy/";

export interface ProviderConnection {
  /** The proxy base for this provider or custom model, or the account peer's address. */
  baseURL: string;
  /** The proxy token, or the account peer's token. Never a provider key. */
  apiKey: string;
  /** Extra request headers the provider's calls need. */
  headers: Record<string, string>;
  /** Proxy-aware fetch: renews the proxy token on 401 `proxy_token_expired`. */
  fetch?: typeof fetch;
}

/** The connection fields a provider adapter reads from its call params. */
export interface ConnectionParams {
  apiKey: string;
  baseURL?: string;
  providerHeaders?: Record<string, string>;
  providerFetch?: typeof fetch;
}

export class ProviderConnectionRequiredError extends Error {
  readonly code = "provider_connection_required";
  constructor(label: string) {
    super(`${label} calls go through the AI Board model proxy, and this call has no connection. Connect AI Board: run \`aiboard\` in a project folder (not your home folder).`);
    this.name = "ProviderConnectionRequiredError";
  }
}

export function connectionFromParams(params: ConnectionParams): ProviderConnection | null {
  const baseURL = params.baseURL?.trim();
  if (!baseURL) return null;
  return {
    baseURL,
    apiKey: params.apiKey,
    headers: params.providerHeaders ?? {},
    ...(params.providerFetch ? { fetch: params.providerFetch } : {}),
  };
}

export function connectionParams(connection: ProviderConnection): Required<Pick<ConnectionParams, "apiKey" | "baseURL" | "providerHeaders">> & Pick<ConnectionParams, "providerFetch"> {
  return {
    apiKey: connection.apiKey,
    baseURL: connection.baseURL,
    providerHeaders: connection.headers,
    ...(connection.fetch ? { providerFetch: connection.fetch } : {}),
  };
}

/** True for a model-proxy base URL; SDK clients are built only for these. */
export function isModelProxyBaseURL(baseURL: string): boolean {
  try {
    const url = new URL(baseURL);
    return url.pathname.startsWith(MODEL_PROXY_PATH_PREFIX);
  } catch {
    return false;
  }
}

/** A client needs a resolved base URL; there is no default provider host to fall back to. */
function proxiedConnection(params: ConnectionParams, label: string): ProviderConnection {
  const connection = connectionFromParams(params);
  if (!connection) throw new ProviderConnectionRequiredError(label);
  return connection;
}

export interface SdkClientOptions {
  disableAutomaticRetries?: boolean;
  timeout?: number;
  defaultHeaders?: Record<string, string>;
}

export function createOpenAIClient(
  params: ConnectionParams,
  label: string,
  options: SdkClientOptions = {},
): OpenAI {
  const connection = proxiedConnection(params, label);
  return new OpenAI({
    apiKey: connection.apiKey,
    baseURL: connection.baseURL,
    dangerouslyAllowBrowser: true,
    defaultHeaders: { ...options.defaultHeaders, ...connection.headers },
    ...(connection.fetch ? { fetch: connection.fetch } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.disableAutomaticRetries ? { maxRetries: 0 } : {}),
  });
}

export function createAnthropicClient(
  params: ConnectionParams,
  label: string,
  options: SdkClientOptions = {},
): Anthropic {
  const connection = proxiedConnection(params, label);
  return new Anthropic({
    apiKey: connection.apiKey,
    baseURL: connection.baseURL,
    dangerouslyAllowBrowser: true,
    defaultHeaders: { ...options.defaultHeaders, ...connection.headers },
    ...(connection.fetch ? { fetch: connection.fetch } : {}),
    ...(options.disableAutomaticRetries ? { maxRetries: 0 } : {}),
  });
}

/**
 * Google's SDK takes no custom fetch, so its token is the one the resolver
 * handed out; the resolver renews a session before it nears expiry.
 */
export function createGoogleClient(
  params: ConnectionParams,
  label = "Google Gemini",
): GoogleGenAI {
  const connection = proxiedConnection(params, label);
  return new GoogleGenAI({
    apiKey: connection.apiKey,
    httpOptions: {
      baseUrl: connection.baseURL,
      apiVersion: "v1beta",
      headers: { ...connection.headers },
    },
  });
}

/** A raw provider request below the connection's base, with the token in the Bearer header. */
export async function providerFetch(
  params: ConnectionParams,
  label: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const connection = proxiedConnection(params, label);
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(connection.headers)) headers.set(name, value);
  headers.set("authorization", `Bearer ${connection.apiKey}`);
  const url = `${connection.baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  return (connection.fetch ?? fetch)(url, { ...init, headers });
}
