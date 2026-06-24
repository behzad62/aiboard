"use client";

import {
  GameAIPresence,
  type GameAIPresenceProps,
} from "@/components/games/GameAIPresence";

export type AIPresenceProps = GameAIPresenceProps;

export function AIPresence(props: AIPresenceProps) {
  return <GameAIPresence {...props} />;
}

export default AIPresence;
