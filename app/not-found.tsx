import Link from "next/link";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Page not found",
  description: "That page does not exist.",
  path: "/404",
  noindex: true,
});

const link = "underline underline-offset-4 hover:text-foreground";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-3xl py-16">
      <h1 className="font-display text-3xl font-semibold tracking-tight">
        Page not found
      </h1>
      <p className="mt-3 text-muted-foreground">
        That URL does not exist. It may have been renamed, or the link that sent
        you here may be out of date.
      </p>
      <ul className="mt-8 space-y-2 text-muted-foreground">
        <li>
          <Link href="/" className={link}>
            Start a discussion
          </Link>{" "}
          — the dashboard.
        </li>
        <li>
          <Link href="/about" className={link}>
            About AI Board
          </Link>{" "}
          — how the whole thing works.
        </li>
        <li>
          <Link href="/games" className={link}>
            Games
          </Link>{" "}
          — play against the models.
        </li>
        <li>
          <Link href="/settings" className={link}>
            Settings
          </Link>{" "}
          — provider keys and storage.
        </li>
      </ul>
    </div>
  );
}
