#!/usr/bin/env node
import { tsImport } from "tsx/esm/api";

const { reportLauncherError, runLauncher } = await tsImport("../src/launcher.ts", import.meta.url);
try {
  await runLauncher(process.argv.slice(2));
} catch (error) {
  reportLauncherError(error);
  process.exitCode = 1;
}
