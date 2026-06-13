/** Runner file-tool regression checks (run: npx tsx scripts/test-runner-file-tools.mts) */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

async function post(port: number, token: string, endpoint: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runner-token": token },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function waitForRunner(port: number, token: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { "x-runner-token": token },
      });
      if (res.ok) return;
    } catch {
      // runner is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("runner did not start");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "adb-runner-tools-"));
fs.mkdirSync(path.join(root, "src"));
const filePath = path.join(root, "src", "sample.ts");
fs.writeFileSync(
  filePath,
  ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;"].join("\n"),
  "utf8"
);

const port = 19_000 + Math.floor(Math.random() * 1_000);
const token = "test-token";
let child: ChildProcessWithoutNullStreams | null = null;
let runnerLog = "";

try {
  child = spawn(process.execPath, ["scripts/runner.mjs", root, "--port", String(port), "--token", token], {
    cwd: process.cwd(),
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => {
    runnerLog += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    runnerLog += String(chunk);
  });
  await waitForRunner(port, token);

  const read = await post(port, token, "/read", {
    path: "src/sample.ts",
  });
  check("read returns HTTP 200", read.res.status === 200, read.data);
  check("read returns file content", read.data.content.includes("const a = 1;"), read.data);

  const ranged = await post(port, token, "/read-range", {
    path: "src/sample.ts",
    startLine: 2,
    lineCount: 2,
  });
  check("read-range returns HTTP 200", ranged.res.status === 200, ranged.data);
  check("read-range returns requested lines", ranged.data.content === "const b = 2;\nconst c = 3;", ranged.data);
  check(
    "read-range includes line metadata",
    ranged.data.startLine === 2 && ranged.data.endLine === 3 && ranged.data.totalLines === 4,
    ranged.data
  );
  check("read-range partial window is not marked truncated", ranged.data.truncated === false, ranged.data);
  check("read-range partial window reports more lines", ranged.data.hasMoreBefore === true && ranged.data.hasMoreAfter === true, ranged.data);

  const cappedRange = await post(port, token, "/read-range", {
    path: "src/sample.ts",
    startLine: 1,
    lineCount: 999,
  });
  check("read-range over max range is marked capped/truncated", cappedRange.data.truncated === true, cappedRange.data);

  const searched = await post(port, token, "/search", {
    query: "const b",
  });
  check("search returns HTTP 200", searched.res.status === 200, searched.data);
  check("search returns matching line", searched.data.results?.[0]?.path === "src/sample.ts", searched.data);

  const patched = await post(port, token, "/patch", {
    path: "src/sample.ts",
    ops: [{ search: "const b = 2;", replace: "const b = 20;" }],
  });
  check("patch returns HTTP 200", patched.res.status === 200, patched.data);
  check("patch applies exact op", patched.data.applied === 1 && patched.data.failed === 0, patched.data);
  check(
    "patch changes only target text",
    fs.readFileSync(filePath, "utf8") ===
      ["const a = 1;", "const b = 20;", "const c = 3;", "const d = 4;"].join("\n"),
    fs.readFileSync(filePath, "utf8")
  );

  const missed = await post(port, token, "/patch", {
    path: "src/sample.ts",
    ops: [{ search: "missing text", replace: "bad" }],
  });
  check("patch reports failed op safely", missed.data.applied === 0 && missed.data.failed === 1, missed.data);
  check("failed patch leaves file unchanged", !fs.readFileSync(filePath, "utf8").includes("bad"));

  const appended1 = await post(port, token, "/append", {
    path: "tests/generated.ts",
    content: "const first = 1;\n",
    reset: true,
  });
  const appended2 = await post(port, token, "/append", {
    path: "tests/generated.ts",
    content: "const second = 2;\n",
  });
  const generatedPath = path.join(root, "tests", "generated.ts");
  check("append reset returns HTTP 200", appended1.res.status === 200, appended1.data);
  check("append continuation returns HTTP 200", appended2.res.status === 200, appended2.data);
  check(
    "append builds file from chunks",
    fs.readFileSync(generatedPath, "utf8") === "const first = 1;\nconst second = 2;\n",
    fs.readFileSync(generatedPath, "utf8")
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  check("runner logs read tool usage", runnerLog.includes("[read]"), runnerLog);
  check("runner logs read-range tool usage", runnerLog.includes("[read-range]"), runnerLog);
  check("runner logs search tool usage", runnerLog.includes("[search]"), runnerLog);
  check("runner logs patch tool usage", runnerLog.includes("[patch]"), runnerLog);
  check("runner logs append tool usage", runnerLog.includes("[append]"), runnerLog);
} finally {
  if (child) child.kill();
}

process.exit(failed === 0 ? 0 : 1);
