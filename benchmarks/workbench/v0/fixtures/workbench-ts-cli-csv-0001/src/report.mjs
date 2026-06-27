import { fileURLToPath } from "node:url";

export const rows = [
  { name: "Ada Lovelace", score: 5 },
  { name: "Grace \"Amazing\" Hopper", score: 7 }
];

export function formatReport(format = "json") {
  return JSON.stringify(rows);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const formatIndex = process.argv.indexOf("--format");
  const format = formatIndex >= 0 ? process.argv[formatIndex + 1] : "json";
  console.log(formatReport(format));
}
