/** Storage permission checks (run: npx tsx scripts/test-storage-permission.mts) */
import {
  queryPermissionGranted,
  verifyPermission,
} from "../lib/client/storage-adapter";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${String(detail)}`}`);
}

let requestCalls = 0;
const deniedWithoutGesture = {
  name: "AIBoard",
  kind: "directory",
  queryPermission: async () => "prompt" as PermissionState,
  requestPermission: async () => {
    requestCalls += 1;
    throw new DOMException("User activation is required", "SecurityError");
  },
} as unknown as FileSystemDirectoryHandle;

let deniedResult: boolean | undefined;
let deniedError: unknown;
try {
  deniedResult = await verifyPermission(deniedWithoutGesture, { isActive: false });
} catch (error) {
  deniedError = error;
}
check(
  "missing user activation returns false instead of rejecting app startup",
  deniedResult === false && deniedError === undefined && requestCalls === 0,
  deniedError
);

requestCalls = 0;
check(
  "startup permission query never opens a request prompt",
  (await queryPermissionGranted(deniedWithoutGesture)) === false &&
    requestCalls === 0
);

requestCalls = 0;
const alreadyGranted = {
  name: "AIBoard",
  kind: "directory",
  queryPermission: async () => "granted" as PermissionState,
  requestPermission: async () => {
    requestCalls += 1;
    return "granted" as PermissionState;
  },
} as unknown as FileSystemDirectoryHandle;
check(
  "already-granted folder permission does not prompt again",
  (await verifyPermission(alreadyGranted)) === true && requestCalls === 0
);

process.exit(failures === 0 ? 0 : 1);
