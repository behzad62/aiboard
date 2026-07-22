import Link from "next/link";
import { getGameCatalog } from "@/lib/games/catalog";

const link = "underline underline-offset-4 hover:text-foreground";

/**
 * Crawlable copy under each game route. The game UI itself is almost entirely
 * controls, so without this a game page carries ~35 words — too thin to rank
 * for anything once it is listed in the sitemap. Also cross-links the other
 * games so no game route depends on /games alone for internal links.
 */
export function GameAboutSection({
  gameId,
  heading,
  paragraphs,
}: {
  gameId: string;
  heading: string;
  paragraphs: string[];
}) {
  const others = getGameCatalog().filter((game) => game.id !== gameId);

  return (
    <section className="border-t bg-background">
      <div className="mx-auto w-full max-w-6xl px-4 py-12">
        <h2 className="font-display text-2xl font-semibold tracking-tight">
          {heading}
        </h2>
        {paragraphs.map((paragraph) => (
          <p key={paragraph} className="mt-3 max-w-3xl text-muted-foreground">
            {paragraph}
          </p>
        ))}

        <h3 className="mt-10 font-semibold">Other games</h3>
        <ul className="mt-3 space-y-2 text-muted-foreground">
          {others.map((game) => (
            <li key={game.id}>
              <Link href={`/games/${game.id}`} className={link}>
                {game.title}
              </Link>{" "}
              — {game.summary}
            </li>
          ))}
        </ul>

        <p className="mt-8 text-muted-foreground">
          Back to{" "}
          <Link href="/games" className={link}>
            all games
          </Link>
          , or read about{" "}
          <Link href="/multi-model-ai-discussions" className={link}>
            multi-model AI discussions
          </Link>{" "}
          — the same models, pointed at your own questions instead of a board.
        </p>
      </div>
    </section>
  );
}
