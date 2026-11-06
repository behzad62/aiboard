import Link from "next/link";
import type { ReactNode } from "react";
import { LEGAL_LAST_UPDATED } from "@/lib/site";

export type LegalSection = {
  /** Fragment id, so other pages and emails can link straight to a section. */
  id: string;
  title: string;
  body: ReactNode;
};

export const legalLink = "underline hover:text-foreground";

const LEGAL_PAGES = [
  { href: "/terms", label: "Terms of Service" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/refunds", label: "Refund Policy" },
];

/**
 * Shared shell for /terms, /privacy and /refunds: title, plain-English
 * summary, a table of contents, then the numbered sections. Payment providers'
 * site reviews read these pages, so they must stay public and server-rendered.
 */
export function LegalDocument({
  title,
  summary,
  sections,
}: {
  title: string;
  summary: ReactNode;
  sections: LegalSection[];
}) {
  return (
    <article className="mx-auto max-w-3xl space-y-10">
      <header className="space-y-3">
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          {title}
        </h1>
        <p className="text-sm text-muted-foreground">
          Last updated {LEGAL_LAST_UPDATED}
        </p>
        <nav aria-label="Legal pages" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {LEGAL_PAGES.map((page) =>
            page.label === title ? (
              <span key={page.href} aria-current="page" className="font-semibold">
                {page.label}
              </span>
            ) : (
              <Link key={page.href} href={page.href} className={legalLink}>
                {page.label}
              </Link>
            )
          )}
        </nav>
      </header>

      <section
        aria-labelledby="summary"
        className="space-y-3 rounded-lg border bg-muted/40 p-4 sm:p-5"
      >
        <h2 id="summary" className="font-display text-lg font-semibold">
          The short version
        </h2>
        {summary}
      </section>

      <nav aria-label="Contents" className="space-y-2">
        <h2 className="font-display text-lg font-semibold">Contents</h2>
        <ol className="list-decimal space-y-1 pl-6 text-sm">
          {sections.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`} className={legalLink}>
                {section.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {sections.map((section, index) => (
        <section key={section.id} id={section.id} className="scroll-mt-20 space-y-3">
          <h2 className="font-display text-xl font-semibold">
            {index + 1}. {section.title}
          </h2>
          {section.body}
        </section>
      ))}
    </article>
  );
}
