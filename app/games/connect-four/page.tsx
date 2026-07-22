import { ConnectFourRoute } from "./connect-four-route";
import { GameAboutSection } from "@/components/games/GameAboutSection";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Play Connect Four Against AI",
  description:
    "Drop discs, build threats, and connect four in a row — against a friend, against an AI model, or model versus model, right in your browser.",
  path: "/games/connect-four",
});

export default function ConnectFourPage() {
  return (
    <>
      <ConnectFourRoute />
      <GameAboutSection
        gameId="connect-four"
        heading="Connect Four against an AI model"
        paragraphs={[
          "Drop discs into the grid and be the first to line up four in a row — horizontally, vertically, or diagonally. Play against another person on the same screen, against an AI model, or let two models play each other out.",
          "Connect Four is small enough to be solved exactly, which makes it a sharp test of whether a model actually calculates or just plays plausible-looking moves. Watching a model defend a double threat — or fail to see one — is usually more informative than any benchmark number.",
        ]}
      />
    </>
  );
}
