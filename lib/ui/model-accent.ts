import { getModelDisplayName } from "@/lib/providers/catalog";

/**
 * A stable visual identity assigned to each model participating in a
 * discussion. Classes are written as literal strings so Tailwind's content
 * scanner keeps them in the build.
 */
export interface ModelAccent {
  /** vertical rail bar background */
  bar: string;
  /** small status dot background */
  dot: string;
  /** monogram chip background */
  chipBg: string;
  /** monogram chip / name text color */
  text: string;
  /** faint tint used behind a card header */
  tint: string;
  /** focus ring color */
  ring: string;
}

const PALETTE: ModelAccent[] = [
  {
    bar: "bg-indigo-500",
    dot: "bg-indigo-500",
    chipBg: "bg-indigo-500/12 dark:bg-indigo-400/15",
    text: "text-indigo-700 dark:text-indigo-300",
    tint: "from-indigo-500/[0.07]",
    ring: "ring-indigo-500/30",
  },
  {
    bar: "bg-emerald-500",
    dot: "bg-emerald-500",
    chipBg: "bg-emerald-500/12 dark:bg-emerald-400/15",
    text: "text-emerald-700 dark:text-emerald-300",
    tint: "from-emerald-500/[0.07]",
    ring: "ring-emerald-500/30",
  },
  {
    bar: "bg-amber-500",
    dot: "bg-amber-500",
    chipBg: "bg-amber-500/15 dark:bg-amber-400/15",
    text: "text-amber-700 dark:text-amber-300",
    tint: "from-amber-500/[0.07]",
    ring: "ring-amber-500/30",
  },
  {
    bar: "bg-rose-500",
    dot: "bg-rose-500",
    chipBg: "bg-rose-500/12 dark:bg-rose-400/15",
    text: "text-rose-700 dark:text-rose-300",
    tint: "from-rose-500/[0.07]",
    ring: "ring-rose-500/30",
  },
  {
    bar: "bg-violet-500",
    dot: "bg-violet-500",
    chipBg: "bg-violet-500/12 dark:bg-violet-400/15",
    text: "text-violet-700 dark:text-violet-300",
    tint: "from-violet-500/[0.07]",
    ring: "ring-violet-500/30",
  },
  {
    bar: "bg-sky-500",
    dot: "bg-sky-500",
    chipBg: "bg-sky-500/12 dark:bg-sky-400/15",
    text: "text-sky-700 dark:text-sky-300",
    tint: "from-sky-500/[0.07]",
    ring: "ring-sky-500/30",
  },
];

const NEUTRAL_ACCENT: ModelAccent = {
  bar: "bg-slate-400",
  dot: "bg-slate-400",
  chipBg: "bg-slate-500/10",
  text: "text-slate-600 dark:text-slate-300",
  tint: "from-slate-500/[0.05]",
  ring: "ring-slate-400/30",
};

/** Build a deterministic modelId -> accent map from the participant order. */
export function buildAccentMap(modelIds: string[]): Map<string, ModelAccent> {
  const map = new Map<string, ModelAccent>();
  for (const id of modelIds) {
    if (!map.has(id)) {
      map.set(id, PALETTE[map.size % PALETTE.length]);
    }
  }
  return map;
}

export function accentFor(
  map: Map<string, ModelAccent>,
  modelId: string
): ModelAccent {
  return map.get(modelId) ?? NEUTRAL_ACCENT;
}

/** Two-letter monogram derived from a model's display name. */
export function modelMonogram(modelId: string): string {
  const name = getModelDisplayName(modelId);
  const cleaned = name.replace(/[^A-Za-z0-9 ]/g, " ").trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "AI";
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}
