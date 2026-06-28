"use client";

export function FireworksTranscriptViewer({ transcript }: { transcript: unknown }) {
  return (
    <details className="rounded-md border px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">
        Transcript replay
      </summary>
      <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-950 p-3 text-xs leading-relaxed text-slate-100">
        {JSON.stringify(transcript, null, 2)}
      </pre>
    </details>
  );
}
