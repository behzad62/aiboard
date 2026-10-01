export type ModelCatalogSortId =
  | "name-asc"
  | "name-desc"
  | "id-asc"
  | "id-desc";

export const MODEL_CATALOG_SORT_OPTIONS: ReadonlyArray<{
  id: ModelCatalogSortId;
  label: string;
}> = [
  { id: "name-asc", label: "Name A → Z" },
  { id: "name-desc", label: "Name Z → A" },
  { id: "id-asc", label: "Model ID A → Z" },
  { id: "id-desc", label: "Model ID Z → A" },
];

const catalogCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

export function sortModelCatalog<T extends { id: string; name: string }>(
  models: readonly T[],
  sortId: ModelCatalogSortId,
): T[] {
  const field = sortId.startsWith("name-") ? "name" : "id";
  const direction = sortId.endsWith("-desc") ? -1 : 1;
  return [...models].sort((left, right) => {
    const primary = catalogCollator.compare(left[field], right[field]) * direction;
    if (primary !== 0) return primary;
    return catalogCollator.compare(left.id, right.id) * direction;
  });
}
