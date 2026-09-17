import type { ProcessLaunchResult } from "../../src/process-backend.js";
import childProcess from "node:child_process";
import { NativeProcessLaunchBlockedError, type NativeProcessOperations } from "../../src/native-process-backend.js";

export interface LateBirthOutcome { launchRejected: boolean; result?: ProcessLaunchResult; rejection?: unknown; evidenceDirectory?: string }
export interface LateBirthFixture {
  launch(): Promise<ProcessLaunchResult>;
  verify(outcome: LateBirthOutcome): Promise<void>;
  cleanup(result: ProcessLaunchResult): Promise<void>;
  certify(): Promise<void>;
  removeRoot(): void;
}
export async function runLateBirthFixture(fixture: LateBirthFixture): Promise<void> {
  const outcome: LateBirthOutcome = { launchRejected: false };
  try { outcome.result = await fixture.launch(); }
  catch (error) {
    outcome.launchRejected = true;
    outcome.rejection = error;
    if (error instanceof NativeProcessLaunchBlockedError) {
      outcome.result = error.launchResult;
      outcome.evidenceDirectory = error.evidenceDirectory;
    }
  }
  let verificationRejected = false;
  let primary: unknown;
  try { await fixture.verify(outcome); }
  catch (error) { verificationRejected = true; primary = error; }
  try {
    if (outcome.result) await fixture.cleanup(outcome.result);
    // A nominal rejection or observation of absence is not release proof.
    await fixture.certify();
  } catch (cleanup) {
    // A rejected promise can carry any value, including undefined. Presence is
    // independent of value: retain each failure and its order without filtering.
    throw new AggregateError([...(outcome.launchRejected ? [outcome.rejection] : []), ...(verificationRejected ? [primary] : []), cleanup],
      "Late-birth fixture cleanup is uncertain; exact root and launch evidence retained.");
  }
  if (verificationRejected) {
    if (outcome.launchRejected) throw new AggregateError([outcome.rejection, primary], "Late-birth verification failed; launch evidence retained.");
    throw primary;
  }
  fixture.removeRoot();
}
export const inspectWindowsFixtureBirth: NativeProcessOperations["inspectProcessBirth"] = (pid, platform, attemptDeadlineMs = 2_000) => {
  if (platform !== "windows" || !Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown" };
  try {
    const output = childProcess.execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      // Match the production read-only StartTime query and explicit presence
      // protocol. A separate CIM provider roundtrip can outlive the supervisor's
      // initial holder-publication window and is not the launch observer seam.
      `$ErrorActionPreference='Stop';try{$p=Get-Process -Id ${pid} -ErrorAction Stop;$start=$p.StartTime;if($null-eq$start){throw 'PROCESS_BIRTH_UNAVAILABLE'};'PRESENT:'+$start.ToUniversalTime().ToString('o')}catch{$current=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($null-eq$current){'ABSENT'}else{throw}}`,
    ], { encoding: "utf8", windowsHide: true, timeout: Math.max(1, Math.min(2_000, attemptDeadlineMs)), maxBuffer: 64 * 1024 }).trim();
    if (output === "ABSENT") return { state: "absent" };
    if (output.startsWith("PRESENT:") && output.length > "PRESENT:".length)
      return { state: "present", fingerprint: output.slice("PRESENT:".length).replace(/(\.\d{6})\d+(Z)$/, "$1$2") };
    return { state: "unknown" };
  } catch { return { state: "unknown" }; }
};
