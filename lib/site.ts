// Single source of truth for site identity used by metadata, sitemap, robots,
// and JSON-LD. SITE_URL is the only thing to change after deployment.
import type { Metadata } from "next";

export const SITE_URL = "https://aiboard.me";
export const SITE_NAME = "AI Board";
export const SITE_AUTHOR = "Behzad Shams";
export const SITE_CONTACT_EMAIL = "mail@aiboard.me";
export const SITE_GITHUB_URL = "https://github.com/behzad62/aiboard";
export const SITE_TAGLINE =
  "Multi-model AI discussions that synthesize the best answer";
// Kept under 160 characters so search results never truncate mid-sentence —
// the local-first angle has to survive the cut.
export const SITE_DESCRIPTION =
  "Multi-model AI discussions in your browser: GPT, Claude and Gemini debate your question, then a judge model synthesizes the best answer. Local-first.";

export const OG_IMAGE = "/og.png";
const OG_IMAGE_WIDTH = 1200;
const OG_IMAGE_HEIGHT = 630;

type PageMetaInput = {
  /** Page title WITHOUT the site suffix — the layout template appends it. */
  title: string;
  description: string;
  /** Root-relative path, e.g. "/about". Used for canonical and og:url. */
  path: string;
  /** Set for the home page, whose title already contains the site name. */
  absoluteTitle?: boolean;
  ogTitle?: string;
  ogDescription?: string;
  ogType?: "website" | "article";
  /** Per-user tool pages: keep them out of the index but still followable. */
  noindex?: boolean;
};

/**
 * Builds a COMPLETE metadata block for a page.
 *
 * Next.js merges metadata shallowly: a page-level `openGraph` (or `twitter`)
 * object REPLACES the layout's rather than deep-merging into it. Hand-writing
 * partial blocks per page silently dropped og:image/og:type/og:site_name on
 * the pages that defined one, and left og:url pointing at the home page on the
 * pages that did not. Every page goes through this helper so both halves of
 * that bug stay fixed.
 */
export function pageMetadata(input: PageMetaInput): Metadata {
  const socialTitle =
    input.ogTitle ??
    (input.absoluteTitle ? input.title : `${input.title} · ${SITE_NAME}`);
  const socialDescription = input.ogDescription ?? input.description;

  return {
    title: input.absoluteTitle ? { absolute: input.title } : input.title,
    description: input.description,
    alternates: { canonical: input.path },
    ...(input.noindex ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      type: input.ogType ?? "website",
      siteName: SITE_NAME,
      title: socialTitle,
      description: socialDescription,
      url: input.path,
      images: [
        {
          url: OG_IMAGE,
          width: OG_IMAGE_WIDTH,
          height: OG_IMAGE_HEIGHT,
          alt: socialTitle,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description: socialDescription,
      images: [OG_IMAGE],
    },
  };
}

const publisher = {
  "@type": "Organization",
  name: SITE_NAME,
  url: SITE_URL,
  logo: { "@type": "ImageObject", url: `${SITE_URL}${OG_IMAGE}` },
};

/**
 * Article JSON-LD with the properties Google requires for rich results.
 * Dates are the real git add/modify dates of the page source.
 */
export function articleJsonLd(input: {
  headline: string;
  description: string;
  path: string;
  datePublished: string;
  dateModified: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: input.headline,
    description: input.description,
    url: `${SITE_URL}${input.path}`,
    mainEntityOfPage: `${SITE_URL}${input.path}`,
    image: `${SITE_URL}${OG_IMAGE}`,
    datePublished: input.datePublished,
    dateModified: input.dateModified,
    author: { "@type": "Person", name: SITE_AUTHOR },
    publisher,
  };
}

export function faqJsonLd(entries: { question: string; answer: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: entries.map((entry) => ({
      "@type": "Question",
      name: entry.question,
      acceptedAnswer: { "@type": "Answer", text: entry.answer },
    })),
  };
}

export function jsonLdScriptProps(data: unknown) {
  return {
    type: "application/ld+json",
    dangerouslySetInnerHTML: { __html: JSON.stringify(data) },
  } as const;
}
