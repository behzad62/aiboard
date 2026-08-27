"use client";

export function BuildNoteDraftField({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      <label htmlFor="build-note-guidance" className="block text-xs font-medium">
        Guidance text
      </label>
      <textarea
        id="build-note-guidance"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            onSubmit();
          }
        }}
        rows={2}
        placeholder="e.g. Use Postgres instead of SQLite, and add a dark-mode toggle..."
        className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </div>
  );
}
