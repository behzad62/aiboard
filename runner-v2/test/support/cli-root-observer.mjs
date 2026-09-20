import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Observation only. Never enumerate, signal, remove or infer cleanup authority.
const roots = new Set();
const emit = (record) => process.stderr.write(`C5 CLI root: ${JSON.stringify(record)}\n`);
const record = (path) => {
  const exact = String(path);
  roots.add(exact);
  emit({ event: "created", path: exact });
};
const originalSync = fs.mkdtempSync.bind(fs);
fs.mkdtempSync = (...args) => { const result = originalSync(...args); record(result); return result; };
const originalAsync = fs.promises.mkdtemp.bind(fs.promises);
fs.promises.mkdtemp = async (...args) => { const result = await originalAsync(...args); record(result); return result; };
syncBuiltinESMExports();
process.on("exit", () => {
  for (const path of roots) emit({ event: "exit", path, existsAtExit: fs.existsSync(path) });
});
