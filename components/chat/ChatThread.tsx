"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, Copy, Square } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ChatThreadMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  modelName?: string;
  streaming?: boolean;
}

/** A one-on-one conversation with a pinned composer. */
export function ChatThread({
  messages,
  running,
  canSend,
  sendHint,
  onSend,
  onStop,
}: {
  messages: ChatThreadMessage[];
  running: boolean;
  canSend: boolean;
  /** Shown above the composer when sending is blocked (e.g. a failed turn). */
  sendHint?: string | null;
  onSend: (text: string) => boolean;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  // Follow the stream only while the reader is already at the bottom.
  useEffect(() => {
    const onScroll = () => {
      const distance =
        document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
      followRef.current = distance < 160;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const lastContent = messages[messages.length - 1]?.content;
  useEffect(() => {
    if (followRef.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, lastContent]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || running || !canSend) return;
    followRef.current = true;
    if (onSend(text)) setDraft("");
  };

  return (
    <div className="flex min-h-[calc(100dvh-16rem)] flex-col">
      <ol aria-label="Conversation" className="flex-1 space-y-6 pb-6">
        {messages.map((message) => (
          <li
            key={message.id}
            className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}
          >
            {message.role === "user" ? (
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary/12 px-4 py-2.5 text-[0.95rem] leading-relaxed text-foreground sm:max-w-[75%]">
                <span className="sr-only">You: </span>
                {message.content}
              </div>
            ) : (
              <div className="group w-full min-w-0">
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                  {message.modelName ?? "Assistant"}
                </p>
                {message.content ? (
                  <Markdown content={message.content} className="text-[0.95rem]" />
                ) : (
                  <p className="text-sm text-muted-foreground" aria-live="polite">
                    <span className="inline-flex gap-1" aria-hidden="true">
                      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground motion-safe:animate-pulse" />
                      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground motion-safe:animate-pulse [animation-delay:150ms]" />
                      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground motion-safe:animate-pulse [animation-delay:300ms]" />
                    </span>
                    <span className="sr-only">Thinking…</span>
                  </p>
                )}
                {!message.streaming && message.content && (
                  <CopyButton text={message.content} />
                )}
              </div>
            )}
          </li>
        ))}
      </ol>

      <div className="sticky bottom-0 z-10 pb-4 pt-6">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-4 bottom-0 bg-gradient-to-b from-transparent via-background/85 to-background backdrop-blur-md [mask-image:linear-gradient(to_bottom,transparent,#000_32px)]"
        />
        <div className="relative space-y-2">
          {sendHint && (
            <p role="status" className="px-1 text-sm text-muted-foreground">
              {sendHint}
            </p>
          )}
          <form
            onSubmit={submit}
            className="glass-strong flex items-end gap-2 rounded-2xl border p-2 focus-within:ring-2 focus-within:ring-ring"
          >
            <label htmlFor="chat-composer" className="sr-only">
              Message
            </label>
            <textarea
              id="chat-composer"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
              rows={1}
              placeholder={running ? "Waiting for the reply…" : "Message…  (Shift+Enter for a new line)"}
              disabled={!canSend && !running}
              className="block max-h-56 min-h-[2.75rem] w-full flex-1 resize-none bg-transparent px-2 py-2.5 text-[0.95rem] placeholder:text-muted-foreground focus-visible:outline-none [field-sizing:content]"
            />
            {running ? (
              <Button type="button" variant="outline" size="icon" className="h-10 w-10 shrink-0 rounded-xl" onClick={onStop} aria-label="Stop the reply">
                <Square className="h-4 w-4" aria-hidden="true" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                className="h-10 w-10 shrink-0 rounded-xl"
                disabled={!draft.trim() || !canSend}
                aria-label="Send message"
              >
                <ArrowUp className="h-4 w-4" aria-hidden="true" />
              </Button>
            )}
          </form>
        </div>
      </div>
      {/* Scroll target below the composer so the newest message clears it. */}
      <div ref={endRef} />
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="mt-1 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground opacity-70 transition hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
    >
      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
