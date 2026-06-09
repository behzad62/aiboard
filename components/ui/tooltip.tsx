"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const TooltipProvider = ({ children }: { children: React.ReactNode }) => (
  <>{children}</>
);

const Tooltip = ({ children }: { children: React.ReactNode }) => (
  <span className="group relative inline-flex">{children}</span>
);

const TooltipTrigger = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement> & { asChild?: boolean }
>(({ className, children, asChild, ...props }, ref) => {
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children as React.ReactElement<{ className?: string }>, {
      className: cn(
        (children as React.ReactElement<{ className?: string }>).props.className,
        className
      ),
    });
  }
  return (
    <span ref={ref} className={cn("inline-flex", className)} {...props}>
      {children}
    </span>
  );
});
TooltipTrigger.displayName = "TooltipTrigger";

const TooltipContent = ({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    role="tooltip"
    className={cn(
      "pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden w-max max-w-xs -translate-x-1/2 rounded-md border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md group-hover:block",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
