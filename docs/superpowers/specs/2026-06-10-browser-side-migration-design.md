# Browser-Side Migration — Design

Date: 2026-06-10
Status: Approved (autonomous implementation P1 → P2 → P3)

## Goal

Move execution and storage off the server so the app runs entirely client-side
(deployable as a static site). Minimal server resources; per-user, BYO-key.

## Decisions (locked)

- **Storage:** IndexedDB is the universal default (desktop + mobile). Optional
  **File System Access** folder on desktop Chromium for cross-browser /
  cross-device (cloud-folder) sharing. Chosen in **Settings → Storage**.
- **Key security:** passphrase encryption via Web Crypto (PBKDF2 → AES-GCM).
  The **whole store blob** is encrypted when encryption is on (required for
  folder mode, offered for IndexedDB). One unlock per tab session (derived key
  cached in memory). Zero-knowledge — no recovery.
- **Phased**, review-free: P1 foundation → P2 cutover → P3 cleanup.

## Architecture

- **StorageAdapter** (`lib/client/storage-adapter.ts`): `load()/save(blob)`,
  `kind`. Implementations: `IndexedDBAdapter` (single `kv` store, key `store`),
  `FileSystemAdapter` (single `store.json` in a picked folder; dir handle
  persisted in IndexedDB; permission re-grant per session).
- **CryptoBox** (`lib/client/crypto-box.ts`): envelope
  `{v, encrypted, salt?, iv?, data|ciphertext}`. PBKDF2(passphrase, salt) →
  AES-GCM. Caches the derived key in memory for the session.
- **Client store** (`lib/client/store.ts`): in-memory `Store` loaded once
  (async) from the adapter; **sync reads**, mutations persist async (debounced).
  Mirrors the current `lib/db` API shape so call sites change minimally.
- **Client backend** (`lib/client/api.ts`): functions mirroring the API routes
  (loadDashboard, createDiscussion, getDiscussion, deleteDiscussion,
  runDiscussion(onEvent), saveKeys, saveSettings, custom-model CRUD/test,
  validateProvider, attachments). Pages call these instead of `fetch`.
- **Client engine**: the orchestrator ported to the browser — async generator
  that calls `onEvent` (replacing SSE). Providers run in-browser
  (`dangerouslyAllowBrowser` for OpenAI/Anthropic, browser header for Anthropic;
  Gemini/OpenRouter native). Decrypted keys come from the client store.

## Phase 1 — Storage foundation (additive, no cutover)

- StorageAdapter (IndexedDB + FileSystem) + CryptoBox + in-memory client store.
- **Settings → Storage** tab: location (This browser / Local folder + picker),
  passphrase enable/set/unlock, and **Import from server** (one-time).
- Temporary `GET /api/export` returns the current store with **decrypted** keys
  (server has the secret; localhost only) so the client can re-encrypt under the
  passphrase. Existing server-encrypted keys can't be decrypted client-side, so
  import-with-decryption is the migration path.
- Verify: storage round-trips (write → reload → read), encryption locks/unlocks,
  folder mode writes `store.json`.

## Phase 2 — Cutover

- Repoint `lib/db` consumers (engine, providers, pages) at the client store;
  pages call `lib/client/api.ts` instead of `fetch`; engine runs in-browser with
  `onEvent` callbacks; drop the SSE stream route. Providers gain browser flags.
- After this the app runs client-side. Closing the tab stops an in-progress run.

## Phase 3 — Cleanup

- Attachments fully client-side (base64 in the store). Delete `app/api/*`.
- `next.config` → `output: "export"` for static hosting (client-side dynamic
  routes for `/discussion/[id]`).

## Risks / notes

- **CORS:** OpenAI/Anthropic/Gemini/OpenRouter allow browser calls with flags.
  Local **Ollama** blocks browser requests until `OLLAMA_ORIGINS` is set — show a
  hint in the custom-model UI.
- **FSA:** desktop Chromium only; per-session permission; last-write-wins on
  concurrent writes (add a write-timestamp guard + external-change warning).
- **Mobile:** only IndexedDB offered.
- One-time import passes decrypted keys over localhost — acceptable for the
  user's own machine; the temporary export route is removed in P3.
