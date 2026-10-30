function deadline(promise, milliseconds, message) {
  let timer;
  const timed = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); });
  return Promise.race([promise, timed]).finally(() => clearTimeout(timer));
}

/** Bound the SDK handshake and ping, then require the SDK-owned child to close. */
export async function runCopilotSmoke(client, options = {}) {
  const operationMs = options.operationMs ?? 30_000;
  const cleanupMs = options.cleanupMs ?? 30_000;
  const errors = [];
  const started = client.start();
  // Observe rejection immediately even if the deadline fires first.
  void started.catch(() => {});
  const child = client.cliProcess;
  const closed = child ? new Promise((resolve) => child.once("close", resolve)) : undefined;
  let ping;
  try {
    if (!child || !closed) throw new Error("Copilot SDK did not supply an owned runtime process.");
    await deadline(started, operationMs, "Copilot SDK start timed out.");
    ping = client.ping("aiboard-release-smoke");
    void ping.catch(() => {});
    const response = await deadline(ping, operationMs, "Copilot SDK ping timed out.");
    if (typeof response?.message !== "string") throw new Error("Copilot SDK ping did not receive a response.");
  } catch (error) { errors.push(error); }

  try {
    const cleanupErrors = await deadline(client.stop(), cleanupMs, "Copilot SDK stop timed out; runtime cleanup is unverified.");
    errors.push(...cleanupErrors);
  } catch (error) { errors.push(error); }
  if (closed) {
    try { await deadline(closed, cleanupMs, "Copilot SDK runtime did not close; cleanup is unverified."); }
    catch (error) { errors.push(error); }
  }
  for (const pending of [started, ping].filter(Boolean)) {
    try { await deadline(pending.then(() => undefined, () => undefined), cleanupMs, "Copilot SDK request did not settle after cleanup."); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Copilot SDK smoke failed or cleanup could not be verified; state is retained.");
}
