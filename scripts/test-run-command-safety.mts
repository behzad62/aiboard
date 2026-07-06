/** Build command safety checks (run: npx tsx scripts/test-run-command-safety.mts) */
import { classifyRunCommand, classifyVerifyCommand } from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const allowed = [
  "npm test",
  "npm run test",
  "npx --yes tsc --noEmit",
  "npx tsx tests/run-tests.ts",
  "node -e \"const fs=require('fs');console.log(fs.readFileSync('tests/run-tests.ts','utf8').slice(0,20))\"",
  "node -e \"console.log(process.platform)\"",
];

for (const command of allowed) {
  const result = classifyRunCommand(command);
  check(`allows ${command}`, result.allowed, result);
}

const rejected = [
  "node -e \"const fs=require('fs');fs.writeFileSync('tests/run-tests.ts','broken')\"",
  "node -e \"require('fs').appendFileSync('README.md','x')\"",
  "node -e \"const fs=require('fs');fs.rmSync('dist',{recursive:true})\"",
  "echo hello > README.md",
  "echo hello >> README.md",
  "powershell -Command Set-Content README.md hello",
  "pwsh -Command Add-Content README.md hello",
  "sed -i s/foo/bar/g src/index.ts",
  "perl -pi -e s/foo/bar/g src/index.ts",
];

for (const command of rejected) {
  const result = classifyRunCommand(command);
  check(`rejects ${command}`, !result.allowed && !!result.reason, result);
}

const windowsRejectedVerify = [
  "test -f index.html",
  "npm test && test -f out/index.html",
  "grep -R TODO src",
];

for (const command of windowsRejectedVerify) {
  const result = classifyVerifyCommand(command, "win32");
  check(
    `rejects Windows-incompatible verifier ${command}`,
    !result.allowed && !!result.reason,
    result
  );
}

const crossPlatformVerifier =
  "node -e \"const fs=require('fs'); if (!fs.existsSync('index.html')) process.exit(1)\"";
check(
  "allows cross-platform Node verifier on Windows",
  classifyVerifyCommand(crossPlatformVerifier, "win32").allowed,
  classifyVerifyCommand(crossPlatformVerifier, "win32")
);
check(
  "keeps POSIX verifier available on POSIX runners",
  classifyVerifyCommand("test -f index.html", "linux").allowed,
  classifyVerifyCommand("test -f index.html", "linux")
);

process.exit(failed === 0 ? 0 : 1);
