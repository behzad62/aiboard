import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MODEL_CATALOG_SORT_OPTIONS,
  sortModelCatalog,
} from "../lib/client/model-catalog-sort";

const models = [
  { id: "vendor/model-10", name: "Gamma" },
  { id: "vendor/model-2", name: "alpha" },
  { id: "vendor/model-1", name: "Beta" },
];

assert.deepEqual(
  sortModelCatalog(models, "name-asc").map((model) => model.name),
  ["alpha", "Beta", "Gamma"],
  "name ascending should be case-insensitive",
);
assert.deepEqual(
  sortModelCatalog(models, "name-desc").map((model) => model.name),
  ["Gamma", "Beta", "alpha"],
  "name descending should reverse the catalogue order",
);
assert.deepEqual(
  sortModelCatalog(models, "id-asc").map((model) => model.id),
  ["vendor/model-1", "vendor/model-2", "vendor/model-10"],
  "model id sorting should be numeric-aware",
);
assert.deepEqual(
  models.map((model) => model.id),
  ["vendor/model-10", "vendor/model-2", "vendor/model-1"],
  "sorting must not mutate the fetched provider catalogue",
);
assert.deepEqual(
  MODEL_CATALOG_SORT_OPTIONS.map((option) => option.id),
  ["name-asc", "name-desc", "id-asc", "id-desc"],
);

const ui = await readFile("components/ApiKeyForm.tsx", "utf8");
assert.match(ui, /Sort catalogue/);
assert.match(ui, /MODEL_CATALOG_SORT_OPTIONS/);
assert.match(ui, /sortModelCatalog/);
console.log("PASS provider model catalogues support deterministic sorting");
