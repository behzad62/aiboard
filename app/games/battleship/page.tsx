import { BattleshipRoute } from "./battleship-route";
import { GameAboutSection } from "@/components/games/GameAboutSection";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Play Battleship Against AI",
  description:
    "Call coordinates, read the board, and sink the hidden fleet — against a friend, against an AI model, or model versus model, in your browser.",
  path: "/games/battleship",
});

export default function BattleshipPage() {
  return (
    <>
      <BattleshipRoute />
      <GameAboutSection
        gameId="battleship"
        heading="Battleship against an AI model"
        paragraphs={[
          "Place your fleet, call coordinates, and work out where the remaining ships must be from the hits and misses you have already recorded. Play against another person, against an AI model, or let two models hunt each other's fleets.",
          "Battleship rewards reasoning under uncertainty: every miss narrows the space of possible placements, and a strong player tracks which squares could still hold a ship of each remaining size. It is a good way to see whether a model updates on evidence or keeps firing at squares its own earlier shots have already ruled out.",
        ]}
      />
    </>
  );
}
