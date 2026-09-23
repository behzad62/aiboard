import { QuoridorRoute } from "./quoridor-route";
import { GameAboutSection } from "@/components/games/GameAboutSection";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Play Quoridor Against AI",
  description:
    "Race your pawn across the board and place walls to lengthen the other path — against a friend, against an AI model, or model versus model, right in your browser.",
  path: "/games/quoridor",
});

export default function QuoridorPage() {
  return (
    <>
      <QuoridorRoute />
      <GameAboutSection
        gameId="quoridor"
        heading="Quoridor against an AI model"
        paragraphs={[
          "Each turn you either step your pawn or drop a two-span wall. First pawn to the opposite side wins, and a wall is only legal if both players still have a path to their goal.",
          "The interesting decisions are the fences: a wall that looks aggressive can be illegal, and a quiet pawn step can be the race. Watching a model keep a path open — or accidentally box itself in — says more than a static puzzle ever could.",
        ]}
      />
    </>
  );
}
