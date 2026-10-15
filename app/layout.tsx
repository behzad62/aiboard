import type { Metadata } from "next";
import { Inter, Fraunces, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import { Code } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  SITE_CONTACT_EMAIL,
  SITE_DESCRIPTION,
  SITE_GITHUB_URL,
  SITE_NAME,
  SITE_URL,
} from "@/lib/site";
import "./globals.css";

// Applies the saved theme before paint to avoid a flash of the wrong theme on
// load. Dark is the default — light only when the user explicitly chose it.
const themeScript = `(function(){try{var t=localStorage.getItem('theme');if(t!=='light')document.documentElement.classList.add('dark');}catch(e){document.documentElement.classList.add('dark');}})();`;

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_NAME,
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: "/favicon.svg",
  },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: "/",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: SITE_NAME }],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    images: ["/og.png"],
  },
};

const footerLink = "underline-offset-4 hover:text-foreground hover:underline";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${fraunces.variable} ${jetbrainsMono.variable} ${inter.className}`}
      >
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <div className="flex min-h-screen flex-col">
          <header className="glass-bar sticky top-0 z-40 border-b">
            <div className="mx-auto flex h-14 w-full max-w-[100rem] items-center gap-2 px-4 sm:gap-4 sm:px-6">
              <Link
                href="/"
                className="flex shrink-0 items-center gap-2.5 font-display text-xl font-semibold tracking-tight"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- static export; the SVG mark is tiny */}
                <img
                  src="/favicon.svg"
                  width={28}
                  height={28}
                  alt=""
                  aria-hidden="true"
                  className="rounded-lg shadow-[0_3px_12px_#2563eb22]"
                />
                {SITE_NAME}
              </Link>
              <AppNav />
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <a
                  href={SITE_GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="View source on GitHub"
                  title="View source on GitHub"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Code className="h-4 w-4" aria-hidden="true" />
                </a>
                <ThemeToggle />
              </div>
            </div>
          </header>
          <main className="mx-auto w-full flex-1 px-4 py-8 sm:px-6">{children}</main>
          <footer className="px-4 py-6 text-xs text-muted-foreground">
            <div className="mx-auto flex max-w-[100rem] flex-wrap items-center justify-center gap-x-4 gap-y-2">
              <span>© 2026 Behzad Shams · {SITE_NAME}</span>
              <Link href="/about" className={footerLink}>
                About
              </Link>
              <Link href="/runner-guide" className={footerLink}>
                Runner guide
              </Link>
              <a href={`mailto:${SITE_CONTACT_EMAIL}`} className={footerLink}>
                Contact
              </a>
              <a
                href="https://paypal.me/behzadashams"
                target="_blank"
                rel="noopener noreferrer"
                className={footerLink}
              >
                Support this project
              </a>
              <a
                href={`${SITE_GITHUB_URL}/blob/main/LICENSE`}
                target="_blank"
                rel="noopener noreferrer"
                className={footerLink}
              >
                Community Source License
              </a>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
