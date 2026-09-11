interface StreamingOutputReadinessFacade {
  waitForOutput(signal?: AbortSignal): Promise<boolean>;
}

export async function waitForRealStreamingOutputReadiness(
  facade: StreamingOutputReadinessFacade,
  timeoutMs: number,
): Promise<void> {
  const cancellation = new AbortController();
  const timeout = setTimeout(() => cancellation.abort(), timeoutMs);
  timeout.unref();
  try {
    if (!await facade.waitForOutput(cancellation.signal)) {
      throw new Error("B3 real fixture output did not become delivery-ready within its test bound.");
    }
  } finally {
    clearTimeout(timeout);
  }
}
