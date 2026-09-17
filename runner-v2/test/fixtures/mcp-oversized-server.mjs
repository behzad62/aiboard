import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const completionMarker = process.argv[2];
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method !== "initialize") return;
  let written = 0;
  const timer = setInterval(() => {
    process.stdout.write("x".repeat(64 * 1024));
    written += 64 * 1024;
    if (written >= 3 * 1024 * 1024) {
      clearInterval(timer);
      appendFileSync(completionMarker, "oversized-response-completed\n");
    }
  }, 50);
});
