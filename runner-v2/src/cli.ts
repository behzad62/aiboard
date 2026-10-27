import { startRunner } from "./runner-start.js";

export { startRunner, type RunnerStartSeams, type StartedRunner } from "./runner-start.js";

// Production entrypoint: loopback control listener, R1d unavailable transport
// until R4, and the stub session issuer. Test children import runner-start
// directly with injected seams; authentication is never disabled.
void startRunner(process.argv.slice(2));
