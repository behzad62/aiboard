export type ModelCatalogSortId =
  | "name-asc"
  | "name-desc"
  | "id-asc"
  | "id-desc"
  | "newest"
  | "oldest"
  | "input-price-asc"
  | "input-price-desc"
  | "output-price-asc"
  | "output-price-desc";

export interface SortableModelCatalogEntry {
  id: string;
  name: string;
  createdAtMs?: number;
  inputUsdPer1M?: number;
  outputUsdPer1M?: number;
}

export const MODEL_CATALOG_SORT_OPTIONS: ReadonlyArray<{
  id: ModelCatalogSortId;
  label: string;
}> = [
  { id: "name-asc", label: "Name A → Z" },
  { id: "name-desc", label: "Name Z → A" },
  { id: "id-asc", label: "Model ID A → Z" },
  { id: "id-desc", label: "Model ID Z → A" },
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "input-price-asc", label: "Input price low → high" },
  { id: "input-price-desc", label: "Input price high → low" },
  { id: "output-price-asc", label: "Output price low → high" },
  { id: "output-price-desc", label: "Output price high → low" },
];

const catalogCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const BASE_SORT_IDS = new Set<ModelCatalogSortId>(["name-asc", "name-desc", "id-asc", "id-desc"]);

function optionalNumberCompare(left: number | undefined, right: number | undefined, direction: 1 | -1): number {
  const leftValid = typeof left === "number" && Number.isFinite(left);
  const rightValid = typeof right === "number" && Number.isFinite(right);
  if (!leftValid && !rightValid) return 0;
  if (!leftValid) return 1;
  if (!rightValid) return -1;
  return (left - right) * direction;
}

export function availableModelCatalogSortOptions<T extends SortableModelCatalogEntry>(models: readonly T[]) {
  const hasDate = models.some((model) => Number.isFinite(model.createdAtMs));
  const hasInputPrice = models.some((model) => Number.isFinite(model.inputUsdPer1M));
  const hasOutputPrice = models.some((model) => Number.isFinite(model.outputUsdPer1M));
  return MODEL_CATALOG_SORT_OPTIONS.filter((option) =>
    BASE_SORT_IDS.has(option.id) ||
    ((option.id === "newest" || option.id === "oldest") && hasDate) ||
    (option.id.startsWith("input-price-") && hasInputPrice) ||
    (option.id.startsWith("output-price-") && hasOutputPrice)
  );
}

export function sortModelCatalog<T extends SortableModelCatalogEntry>(models: readonly T[], sortId: ModelCatalogSortId): T[] {
  return [...models].sort((left, right) => {
    let primary = 0;
    if (sortId === "name-asc" || sortId === "name-desc") {
      primary = catalogCollator.compare(left.name, right.name) * (sortId === "name-desc" ? -1 : 1);
    } else if (sortId === "id-asc" || sortId === "id-desc") {
      primary = catalogCollator.compare(left.id, right.id) * (sortId === "id-desc" ? -1 : 1);
    } else if (sortId === "newest" || sortId === "oldest") {
      primary = optionalNumberCompare(left.createdAtMs, right.createdAtMs, sortId === "newest" ? -1 : 1);
    } else if (sortId.startsWith("input-price-")) {
      primary = optionalNumberCompare(left.inputUsdPer1M, right.inputUsdPer1M, sortId.endsWith("desc") ? -1 : 1);
    } else {
      primary = optionalNumberCompare(left.outputUsdPer1M, right.outputUsdPer1M, sortId.endsWith("desc") ? -1 : 1);
    }
    return primary !== 0 ? primary : catalogCollator.compare(left.id, right.id);
  });
}
