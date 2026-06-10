"use client";

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

// Pick only the props we render so react-markdown's internal `node` prop is
// never forwarded to the DOM (which would trigger a React warning).
const components: Components = {
  // Open external links in a new tab, safely.
  a: ({ href, title, children }) => (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  // Models can return markdown image links; render them responsively.
  img: ({ src, alt, title }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={typeof src === "string" ? src : undefined}
      alt={alt ?? ""}
      title={title}
      loading="lazy"
    />
  ),
  // Tables need a scroll container so wide markdown tables never blow out layout.
  table: ({ children }) => (
    <div className="my-4 w-full overflow-x-auto rounded-lg border border-border">
      <table className="my-0">{children}</table>
    </div>
  ),
};

export const Markdown = memo(function Markdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "prose prose-slate max-w-none dark:prose-invert",
        "prose-headings:font-display prose-headings:font-semibold prose-headings:tracking-tight",
        "prose-h1:mt-0 prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg",
        "prose-p:leading-relaxed prose-li:my-1 prose-li:leading-relaxed",
        "prose-a:font-medium prose-a:text-primary prose-a:decoration-primary/40 prose-a:underline-offset-2",
        "prose-strong:text-foreground",
        "prose-code:rounded prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:font-mono prose-code:text-[0.85em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none",
        "prose-pre:rounded-xl prose-pre:border prose-pre:border-slate-800 prose-pre:bg-slate-950 prose-pre:text-slate-100 prose-pre:shadow-sm",
        "prose-img:my-3 prose-img:rounded-xl prose-img:border prose-img:border-border prose-img:shadow-sm",
        "prose-th:bg-muted/60 prose-th:px-3 prose-th:py-2 prose-td:px-3 prose-td:py-2 prose-td:align-top",
        "prose-blockquote:border-l-primary/40 prose-blockquote:font-normal prose-blockquote:not-italic prose-blockquote:text-muted-foreground",
        "prose-hr:border-border",
        className
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
