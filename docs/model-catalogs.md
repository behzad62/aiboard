# Model catalogs and details

Providers with a Browse models control start with an empty model list. Add the
models you want from the current catalog or enter their ids. Saved selections
remain available after upgrades; built-in reference records never add models to
your list automatically.

Each added model has a Model details panel. Catalog metadata includes names,
token limits, USD pricing per million tokens (including cached input when
published), input modalities, and declared API parameters. Missing fields remain
unknown, rather than becoming zero prices or negative capability claims. Copilot
credit multipliers are not converted into USD token prices.
Account runner v26 and newer preserve the full ChatGPT catalog metadata for the
browser; update the runner to include any newly published token limits.

Optional per-model overrides let you fill missing details or correct reported
values. Blank numeric fields and the Catalog/Unknown input option use the
provider value. Explicit zero prices and No support are valid values. Save the
provider to persist the model list and details; edits survive catalog refreshes.
Older saved selections without a verified catalog snapshot are refreshed when
their settings form opens. Until a catalog request succeeds, missing fields are
labeled Not checked rather than Not reported. A failed request is shown in the UI.
Switching between OpenAI API and ChatGPT subscription settings preserves each
provider's enabled state; the connection selector only changes the displayed form.

Pricing and context controls live with each model under Providers; there is no
separate Pricing tab. Model details includes pricing and token limit overrides
with separate reset buttons (use Save to apply them). Advanced Build settings
contains reserve tokens, input ceiling, long-context quality, prompt caching,
and recommended roles, with its own Save and Reset controls. Resetting Build
settings preserves pricing and token limit overrides. Foundry deployments and
custom endpoints also provide local pricing and context controls. Existing
overrides remain saved; old `?tab=pricing` links open Providers.

xAI catalog browsing calls only `GET /v1/language-models`, without inference.
xAI can reject that request when the team's credits are exhausted or its monthly
spending limit is reached. The UI preserves the provider's error and explains
the billing restriction. This is distinct from invalid credentials or endpoint
permissions, which retain their own errors.

Browse and Refresh also fetch the public `https://models.dev/api.json` directly
from the browser to fill missing details. No runner or extra API key is needed
for this lookup, and no provider credentials are sent to Models.dev. The lookup
matches the exact provider and model ID and never adds models to the account's
catalog. A six-second timeout or network failure leaves the provider catalog
usable; saved references remain available.

Priority is manual overrides, then provider-reported fields, then Models.dev
references. Each reference shows its source and fetch date in Model details;
provider fields retain their own labels. Save the provider to keep fetched
references. Cost estimates, token budgeting, and attachment checks use these
values. These are community-maintained reference rates, with base token prices
only; modality and context tiers may add charges. Subscription model prices are
API-equivalent comparisons, explicitly labeled as estimates rather than subscription
charges. ChatGPT subscription browsing reads the
model-only `https://models.dev/models.json` catalog and matches the exact
`openai/<model-id>` key. These references can fill missing model specifications,
including output limits, but never override account-reported limits. A separate
public API catalog lookup supplies API-equivalent rates. Copilot uses an exact
canonical-model mapping to its underlying vendor API; Auto has no fixed rate.
Existing local API price settings can supply the same-model comparison without
an API key. Their labels explicitly distinguish underlying model facts from
confirmed subscription limits. Fields without an exact, valid reference stay unknown. API/tool
support evidence remains separate from descriptive model metadata.

Live metadata takes precedence over bundled historical pricing and context
references. Manual overrides take precedence over the live values. Cost estimates,
context profiles, and attachment input checks use these saved details throughout
the app. Unreported prices remain unknown, and unknown attachment types are
disabled until declared. Context scheduling retains its conservative fallback
when no limit has been reported or entered; the details panel identifies the
missing value. Discovery does not establish runtime tool support, which is still
resolved separately through provider policies and scoped evidence.

Usage accounting prefers provider response counts over local estimates. Final
stream usage includes cache and reasoning detail when reported. Anthropic input
totals include cache reads/writes; Gemini includes tool-use prompts in input and
thinking tokens in output. Copilot SDK tool-loop calls are summed once per runner
request. Account runner v28 forwards usage in both JSON and SSE replies. Missing
counts remain explicitly partial/estimated; a reported total and one side can
determine the other without a text estimate. Build stats show API-equivalent
account costs separately from actual budget accounting.
