"use client";

export function NumberField({
  className,
  label,
  max,
  min,
  onChange,
  running,
  value,
}: {
  className?: string;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  running: boolean;
  value: number;
}) {
  return (
    <div className={className}>
      <label className="mb-1 block text-sm font-medium">{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) =>
          onChange(Math.max(min, Math.min(max, Number(event.target.value) || min)))
        }
        disabled={running}
        className="w-24 rounded-md border bg-background px-3 py-2 text-foreground disabled:opacity-50"
      />
    </div>
  );
}
