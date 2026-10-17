/** Strict SSE decoder for provider-side streaming, with the same timeout as JSON calls. */
import { ProviderTransportError } from "./account-runner-model.js";
import { PROVIDER_REQUEST_TIMEOUT_MS } from "./provider-model-utils.js";

export async function* readProviderSse(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): AsyncGenerator<{ type: string; data: Record<string, unknown> }> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), PROVIDER_REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetchImpl(url, { ...init, signal });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: { message?: string; code?: string } | string };
      const detail = typeof payload.error === "string" ? payload.error : payload.error?.message;
      throw new ProviderTransportError(detail ?? `Provider stream failed (HTTP ${response.status})`, response.status);
    }
    if (!response.body) throw new ProviderTransportError("Provider stream has no body", response.status);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      pending = pending.replace(/\r\n/g, "\n");
      if (pending.length > 1_000_000) throw new ProviderTransportError("Provider stream frame too large");
      let end: number;
      while ((end = pending.indexOf("\n\n")) !== -1) {
        const block = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const type = block.split("\n").find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
        const raw = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!raw || raw === "[DONE]") continue;
        let data: unknown;
        try { data = JSON.parse(raw); }
        catch { continue; }
        if (!data || typeof data !== "object" || Array.isArray(data)) continue;
        if (type === "error" || (data as { error?: unknown }).error) {
          throw new ProviderTransportError("Provider sent a streaming error");
        }
        yield { type, data: data as Record<string, unknown> };
      }
    }
  } catch (error) {
    if (timeout.signal.aborted && !init.signal?.aborted) {
      throw new ProviderTransportError("Provider streaming request timed out", undefined, "timeout");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
