import { GamesClient } from "./games-client";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Games — Play Chess, Connect Four & More Against AI",
  description:
    "Play chess, Connect Four, Battleship, Codenames, and Fireworks in your browser — against a friend, against an AI model, or model versus model.",
  path: "/games",
});

export default function GamesPage() {
  return <GamesClient />;
}
