import * as React from "react";
import { cn } from "@/lib/utils";

function Badge({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  variant?: "default" | "secondary" | "outline" | "success" | "warning" | "destructive";
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
        {
          default: "border-transparent bg-primary text-primary-foreground",
          secondary: "border-transparent bg-secondary text-secondary-foreground",
          outline: "text-foreground",
          success: "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100",
          warning: "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100",
          destructive: "border-transparent bg-destructive text-destructive-foreground",
        }[variant],
        className
      )}
      {...props}
    />
  );
}

export { Badge };
