"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";

/**
 * Each game lives at its own route, so "back to games" is a navigation rather
 * than a state reset. Kept in one place so every game route agrees on it.
 */
export function useBackToGames() {
  const router = useRouter();
  return useCallback(() => router.push("/games"), [router]);
}
