/* Stress benchmark checks (run: npx tsx scripts/test-benchmark-stress.mts)
 * This standalone entrypoint is intentionally separate from package.json so agents
 * can run the new large-file/tool-use challenge checks without changing the main
 * benchmark test pipeline.
 */

await import("./test-toolreliability-stress-cases.mts");
await import("./test-workbench-v2-challenges.mts");
