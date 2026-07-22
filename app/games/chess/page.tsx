import { ChessRoute } from "./chess-route";
import { GameAboutSection } from "@/components/games/GameAboutSection";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Play Chess Against AI",
  description:
    "Play chess in your browser against another person, against an AI model, or watch two models play each other. No account and no server involved.",
  path: "/games/chess",
});

export default function ChessPage() {
  return (
    <>
      <ChessRoute />
      <GameAboutSection
        gameId="chess"
        heading="Chess against an AI model, or model versus model"
        paragraphs={[
          "Play a full game of chess in the browser with legal-move validation, check and checkmate detection, and standard algebraic notation. Take one side against a friend on the same screen, play against an AI model, or sit out entirely and watch two models play each other move by move.",
          "Because the models reason in natural language before committing to a move, model-versus-model games are a readable way to compare how different models handle tactics, king safety, and long-horizon planning. Games are stored locally in your browser, so you can pause one and resume it later.",
        ]}
      />
    </>
  );
}
