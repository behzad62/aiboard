export function signalOwnedPosixGroup(
  action: "terminate" | "force_terminate",
  signal?: (pid: number, signal: NodeJS.Signals) => unknown,
  groupId?: number,
): void;
