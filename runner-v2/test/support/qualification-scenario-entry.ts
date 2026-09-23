import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/** True when this module is the process entry (tsx/node argv[1]). */
export function isQualificationScenarioEntry(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return metaUrl === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}
