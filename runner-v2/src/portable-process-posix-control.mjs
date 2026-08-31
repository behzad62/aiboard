export function signalOwnedPosixGroup(action, signal = process.kill, groupId = process.pid) {
  const osSignal = action === "force_terminate" ? "SIGKILL" : "SIGTERM";
  signal(-groupId, osSignal);
}
