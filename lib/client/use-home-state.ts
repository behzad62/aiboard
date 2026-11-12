"use client";

import { useSyncExternalStore } from "react";
import { getHomeState, onHomeStateChange, type HomeState } from "./home-client";

const SERVER_STATE: HomeState = { status: "idle" };

/** The AIBoard home's state in this tab (HM4b): loading, not connected, update required, ready. */
export function useHomeState(): HomeState {
  return useSyncExternalStore(
    (listener) => onHomeStateChange(() => listener()),
    getHomeState,
    () => SERVER_STATE,
  );
}
