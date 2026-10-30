// Validate the manual release inputs before any bundle is built.
const version = process.env.AIBOARD_RELEASE_VERSION ?? "";
const sequence = process.env.AIBOARD_RELEASE_SEQUENCE ?? "";
const expiry = process.env.AIBOARD_RELEASE_EXPIRY_DAYS ?? "";

if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error("version must look like 0.2.0");
if (sequence !== "auto" && (!/^[1-9][0-9]*$/.test(sequence) || BigInt(sequence) > 2n ** 40n)) {
  throw new Error("sequence must be auto or an integer from 1 through 1099511627776");
}
if (!/^[0-9]{1,3}$/.test(expiry)) throw new Error("expires_days must be an integer");
