export type CertifiedRunOwner = "advanced" | "preset";

export interface CertifiedRunLock {
  tryAcquire(owner: CertifiedRunOwner): boolean;
  release(owner: CertifiedRunOwner): void;
  activeOwner(): CertifiedRunOwner | null;
}

export function createCertifiedRunLock(): CertifiedRunLock {
  let owner: CertifiedRunOwner | null = null;

  return {
    tryAcquire(nextOwner) {
      if (owner !== null) return false;
      owner = nextOwner;
      return true;
    },
    release(releasingOwner) {
      if (owner === releasingOwner) owner = null;
    },
    activeOwner() {
      return owner;
    },
  };
}
