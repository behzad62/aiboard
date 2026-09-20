import type { LanguageIntelligenceProvider, LanguageInvocationContext } from "./language-intelligence.js";

/** Only the configured-language router implements agent ownership; built-in
 * providers remain unchanged. The actual agent identity is never fabricated. */
export async function withLanguageAgentLifecycle<T>(
  language: Pick<LanguageIntelligenceProvider, "closeAgent"> | undefined,
  owner: Pick<LanguageInvocationContext, "runId" | "sessionId" | "actor">,
  perform: () => Promise<T>,
): Promise<T> {
  const exact = Object.freeze({ runId: owner.runId, sessionId: owner.sessionId, actor: Object.freeze({ ...owner.actor }) });
  let failed = false; let primary: unknown; let result: T | undefined;
  try { result = await perform(); } catch (error) { failed = true; primary = error; }
  try { await language?.closeAgent?.(exact); }
  catch (cleanup) { throw new AggregateError(failed ? [primary, cleanup] : [cleanup], "Agent language-server cleanup remains unverified."); }
  if (failed) throw primary;
  return result!;
}
