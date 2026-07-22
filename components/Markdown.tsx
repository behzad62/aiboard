"use client";

import {
  isValidElement,
  memo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/** Read the `language-xxx` class rehype-highlight leaves on the <code> child. */
function languageOf(children: ReactNode): string | null {
  const child = Array.isArray(children) ? children[0] : children;
  if (!isValidElement(child)) return null;
  const className = (child.props as { className?: string }).className;
  const match = className?.match(/language-([\w+-]+)/);
  return match ? match[1] : null;
}

/**
 * Fenced code block: syntax-highlighted, capped in height with its own
 * scrollbars, with a language badge and a copy button in the header.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const language = languageOf(children);

  const copy = async () => {
    const text = preRef.current?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (e.g. insecure context) — nothing to do
    }
  };

  return (
    <div className="not-prose group/code my-4 overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-800/80 bg-slate-900/80 px-3 py-1.5">
        <span className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-slate-400">
          {language ?? "code"}
        </span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[0.65rem] text-slate-400 opacity-0 transition-opacity hover:bg-slate-800 hover:text-slate-200 focus-visible:opacity-100 group-hover/code:opacity-100"
          aria-label="Copy code"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-400" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" /> Copy
            </>
          )}
        </button>
      </div>
      <pre
        ref={preRef}
        className="max-h-80 overflow-auto p-4 text-[0.825rem] leading-relaxed text-slate-100 [scrollbar-width:thin]"
      >
        {children}
      </pre>
    </div>
  );
}

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
      decoding="async"
    />
  ),
  // Tables need a scroll container so wide markdown tables never blow out layout.
  table: ({ children }) => (
    <div className="my-4 w-full overflow-x-auto rounded-lg border border-border">
      <table className="my-0">{children}</table>
    </div>
  ),
  // Fenced code blocks get highlighting, a header, and their own scrollbars.
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
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
        "prose-img:my-3 prose-img:rounded-xl prose-img:border prose-img:border-border prose-img:shadow-sm",
        "prose-th:bg-muted/60 prose-th:px-3 prose-th:py-2 prose-td:px-3 prose-td:py-2 prose-td:align-top",
        "prose-blockquote:border-l-primary/40 prose-blockquote:font-normal prose-blockquote:not-italic prose-blockquote:text-muted-foreground",
        "prose-hr:border-border",
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
