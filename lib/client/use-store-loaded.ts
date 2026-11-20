"use client";

import { useEffect, useState } from "react";
import { isInitialized, onStoreReady } from "./store";

/**
 * Whether this browser's store has loaded, re-rendering when it does. Pages render before the store has loaded (a
 * large store can take a while), and any store read before then throws "Client store not initialized".
 */
export function useStoreLoaded(): boolean {
  const [loaded, setLoaded] = useState(() => isInitialized());
  useEffect(() => onStoreReady(() => setLoaded(isInitialized())), []);
  return loaded;
}
