#!/usr/bin/env node
import { tsImport } from "tsx/esm/api";

const { runLauncher } = await tsImport("../src/launcher.ts", import.meta.url);
try {
  await runLauncher(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
