const PLACEHOLDER = "__RJS_TRUSTED_RUNTIME_URL__";

export function specializeTrustedModule(source, moduleUrl) {
  if (typeof source !== "string" || typeof moduleUrl !== "string") {
    throw new Error("Trusted module specialization requires source and URL strings.");
  }
  const parsed = new URL(moduleUrl);
  if (parsed.protocol !== "file:") {
    throw new Error("Trusted evaluator must use a local file URL.");
  }
  const pattern = /(['"])__RJS_TRUSTED_RUNTIME_URL__\1/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one quoted ${PLACEHOLDER} placeholder.`);
  }
  const specialized = source.replace(pattern, JSON.stringify(moduleUrl));
  if (specialized.includes(PLACEHOLDER)) {
    throw new Error(`Residual ${PLACEHOLDER} placeholder after specialization.`);
  }
  return specialized;
}
