import { FireworksRoute } from "./fireworks-route";
import { GameAboutSection } from "@/components/games/GameAboutSection";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Play Fireworks — Co-op Card Game",
  description:
    "A cooperative card game of hidden hands and limited clues. Play with friends or with AI teammates and score the team objectively.",
  path: "/games/fireworks",
});

export default function FireworksPage() {
  return (
    <>
      <FireworksRoute />
      <GameAboutSection
        gameId="fireworks"
        heading="Fireworks: a cooperative game of hidden information"
        paragraphs={[
          "Everyone plays on the same side, but you cannot see your own cards — only everyone else's. Players spend a limited pool of clue tokens telling each other what they hold, then play cards in ascending order to complete each colour. Miscount and the team burns a life.",
          "Fireworks is cooperative rather than competitive, so it measures something the other games do not: whether a model can build shared conventions, infer what a teammate's clue was meant to convey, and hold back when the safe move is to discard. The team is scored objectively at the end.",
        ]}
      />
    </>
  );
}
