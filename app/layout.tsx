import type { Metadata } from "next";
import { Inter, Fraunces, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import {
  BarChart3,
  Coffee,
  Github,
  Info,
  Mail,
  MessageSquare,
  Settings,
} from "lucide-react";
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

const navLink =
  "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";
const navIconBtn =
  "inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";
const navDivider = "mx-1.5 h-5 w-px bg-border";

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
        <div className="min-h-screen bg-background">
          <header className="border-b bg-background">
            <div className="mx-auto flex h-14 max-w-[100rem] items-center justify-between px-4">
              <Link href="/" className="flex items-center gap-2 font-semibold">
                <MessageSquare className="h-5 w-5 text-primary" />
                {SITE_NAME}
              </Link>
              <nav className="flex items-center gap-1">
                {/* Project */}
                <Link href="/about" className={navLink}>
                  <Info className="h-4 w-4" />
                  About
                </Link>
                <a href={`mailto:${SITE_CONTACT_EMAIL}`} className={navLink}>
                  <Mail className="h-4 w-4" />
                  Contact
                </a>
                <a
                  href="https://paypal.me/behzadashams"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={navLink}
                >
                  <Coffee className="h-4 w-4" />
                  Support this project
                </a>

                <span className={navDivider} aria-hidden="true" />

                {/* App */}
                <Link href="/benchmark" className={navLink}>
                  <BarChart3 className="h-4 w-4" />
                  Benchmark
                </Link>
                <Link href="/settings" className={navLink}>
                  <Settings className="h-4 w-4" />
                  Settings
                </Link>

                <span className={navDivider} aria-hidden="true" />

                {/* Controls */}
                <a
                  href={SITE_GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="View source on GitHub"
                  title="View source on GitHub"
                  className={navIconBtn}
                >
                  <Github className="h-4 w-4" />
                  <span className="sr-only">View source on GitHub</span>
                </a>
                <ThemeToggle />
              </nav>
            </div>
          </header>
          <main className="mx-auto w-full px-4 py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
