import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MODEL_CATALOG_SORT_OPTIONS,
  availableModelCatalogSortOptions,
  sortModelCatalog,
} from "../lib/client/model-catalog-sort";
import { buildOpenRouterCatalogModel } from "../lib/client/settings-api";

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
  [
    "name-asc", "name-desc", "id-asc", "id-desc",
    "newest", "oldest",
    "input-price-asc", "input-price-desc",
    "output-price-asc", "output-price-desc",
  ],
);

const richModels = [
  { id: "old-cheap", name: "Old Cheap", createdAtMs: 1_700_000_000_000, inputUsdPer1M: 1, outputUsdPer1M: 5 },
  { id: "new-expensive", name: "New Expensive", createdAtMs: 1_800_000_000_000, inputUsdPer1M: 4, outputUsdPer1M: 8 },
  { id: "mid-free", name: "Mid Free", createdAtMs: 1_750_000_000_000, inputUsdPer1M: 0, outputUsdPer1M: 0 },
  { id: "unknown", name: "Unknown" },
];
assert.deepEqual(sortModelCatalog(richModels, "newest").map((model) => model.id), ["new-expensive", "mid-free", "old-cheap", "unknown"]);
assert.deepEqual(sortModelCatalog(richModels, "oldest").map((model) => model.id), ["old-cheap", "mid-free", "new-expensive", "unknown"]);
assert.deepEqual(sortModelCatalog(richModels, "input-price-asc").map((model) => model.id), ["mid-free", "old-cheap", "new-expensive", "unknown"]);
assert.deepEqual(sortModelCatalog(richModels, "output-price-desc").map((model) => model.id), ["new-expensive", "old-cheap", "mid-free", "unknown"]);
assert.deepEqual(
  availableModelCatalogSortOptions(richModels).map((option) => option.id),
  MODEL_CATALOG_SORT_OPTIONS.map((option) => option.id),
);
assert.deepEqual(
  availableModelCatalogSortOptions(models).map((option) => option.id),
  ["name-asc", "name-desc", "id-asc", "id-desc"],
  "date and price sort modes should be hidden when the provider exposes no such metadata",
);

const openRouterModel = buildOpenRouterCatalogModel({
  id: "vendor/priced-model",
  name: "Priced Model",
  created: 1_800_000_000,
  pricing: { prompt: "0.000002", completion: "0.000006" },
  architecture: { input_modalities: ["text"] },
  supported_parameters: [],
});
assert.equal(openRouterModel.createdAtMs, 1_800_000_000_000);
assert.equal(openRouterModel.inputUsdPer1M, 2);
assert.equal(openRouterModel.outputUsdPer1M, 6);

const source = await readFile("lib/client/settings-api.ts", "utf8");
assert.match(source, /model\.created \* 1_000/);
assert.match(source, /Date\.parse\(model\.created_at\)/);

const ui = await readFile("components/ApiKeyForm.tsx", "utf8");
assert.match(ui, /Sort catalogue/);
assert.match(ui, /availableModelCatalogSortOptions/);
assert.match(ui, /Released/);
assert.match(ui, /\/1M input/);
assert.match(ui, /sortModelCatalog/);
console.log("PASS provider model catalogues support deterministic sorting");
