"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, MessagesSquare, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Workspace", icon: MessagesSquare, match: ["/", "/discussion"] },
  { href: "/benchmark", label: "Benchmark", icon: BarChart3, match: ["/benchmark"] },
  { href: "/settings", label: "Settings", icon: Settings, match: ["/settings"] },
] as const;

export function AppNav() {
  const pathname = usePathname() ?? "/";
  return (
    <nav aria-label="Primary" className="flex min-w-0 items-center gap-0.5">
      {LINKS.map(({ href, label, icon: Icon, match }) => {
        const active = match.some((prefix) =>
          prefix === "/" ? pathname === "/" : pathname.startsWith(prefix)
        );
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground sm:px-3",
              active && "bg-accent text-accent-foreground"
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
