import { CodenamesRoute } from "./codenames-route";
import { GameAboutSection } from "@/components/games/GameAboutSection";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Play Codenames Against AI",
  description:
    "Give secret clues, read the grid, and avoid the assassin — play Codenames with friends or with AI models as spymaster or operative.",
  path: "/games/codenames",
});

export default function CodenamesPage() {
  return (
    <>
      <CodenamesRoute />
      <GameAboutSection
        gameId="codenames"
        heading="Codenames with AI models as spymaster or operative"
        paragraphs={[
          "One player sees which words on the grid belong to their team and gives a single-word clue with a number. Their teammates have to guess which words were meant — while avoiding the other team's words and the assassin, which loses the game instantly. Fill either seat with a person or an AI model.",
          "Codenames puts a model's grasp of association and ambiguity on display. A good clue links several of your own words without accidentally pointing at the assassin, which means reasoning about what a clue will suggest to someone else rather than what it means to you.",
        ]}
      />
    </>
  );
}
