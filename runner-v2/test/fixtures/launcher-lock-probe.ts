// Child-process probe for launcher-lock.test.ts: reports whether this process can take a lock the parent holds.
import { tryAcquireLock } from "../../src/launcher-instance.js";

const release = tryAcquireLock(process.argv[2]!, process.argv[3] === "discovery" ? "discovery" : "lifetime");
process.stdout.write(release ? "acquired" : "refused");
release?.();
