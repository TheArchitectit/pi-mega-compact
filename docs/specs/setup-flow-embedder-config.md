# Setup Flow — Embedder Configuration (dashboard + .mega-compact.env loader)

**Date:** 2026-07-31
**Priority:** P1 (user-reported: "the setup menu works, and detects ollama in my case, but I cannot select it")
**Status:** IMPLEMENTED (uncommitted; awaiting gate + commit after the in-flight Track A/B/C workflow lands)

---

## PROBLEM / MOTIVATION

The embedder setup flow was broken end-to-end:

1. **Dashboard SetupTab was detection-only.** It rendered "Detected" badges for Ollama/llama.cpp/ONNX but had no action button to *select* or *configure* an embedder. It told the user to run `/megasetup` in the chat instead — a dead end for dashboard-only users.
2. **`.mega-compact.env` was write-only dead weight.** The TUI `/megasetup` wizard (`extensions/mega-commands.ts:425`) wrote a `.mega-compact.env` file to the state dir, but **the extension never read it back** — config is loaded only from `process.env` at startup (`mega-config.ts:loadConfig`). So even the TUI path required a manual `source` + restart, and the file it wrote was never applied automatically.
3. **Dead code: `mega-embed-wizard.ts`.** A C2 agent created a `/mega-setup-embeddings` command with a wrong `ui.select` object signature (`select({ message, options, submitOnSelect })` — the real pi API is `select(title: string, options: string[], opts?)`). It was also never registered in the extension entry. Pure dead code.

The user could detect Ollama but could not act on the detection.

## DECISIONS

1. **Add a real configure action to the dashboard.** A new `POST /api/setup-configure` route writes the chosen embedder config to `.mega-compact.env`. The SetupTab gains "Use Ollama" / "Use llama.cpp" / "Use Trigram (default)" buttons. The response tells the user whether a restart is required (`alreadyActive` when the new config matches the running env).
2. **Load `.mega-compact.env` at startup.** A new `extensions/mega-runtime/env-loader.ts` parses the file (KEY=VALUE, # comments, quoted values) and applies each key to `process.env` **only if not already set** — so shell/inline env always wins over the file (the user can override without editing it). Runs BEFORE `loadConfig` in the entry point. Non-fatal: missing/malformed file is a no-op.
3. **Delete `mega-embed-wizard.ts`.** Dead code — removed.

## CHANGES

- **NEW `extensions/mega-runtime/env-loader.ts`** — `loadMegaEnv(stateDir)`: parses `.mega-compact.env`, applies to `process.env` without overriding existing keys.
- **`extensions/mega-compact.ts`** — call `loadMegaEnv(loadConfig().stateDir)` before `loadConfig()` (note: the first `loadConfig()` call is only for `stateDir`; the real config load happens after the env file is applied).
- **NEW `POST /api/setup-configure`** (`extensions/dashboard-server/routes-setup.ts:handleSetupConfigure`) — writes `.mega-compact.env` with the chosen embedder URL (or clears it for trigram). Returns `{ embedder, url, envPath, restartRequired, alreadyActive }`.
- **`api-contracts/setup.ts`** — `SetupConfigureRequest` + `SetupConfigureResponse` types.
- **`api-contracts/endpoints.ts` + `index.ts`** — register `setupConfigure` endpoint; re-export types.
- **`dashboard-client/src/api/client.ts`** — `configureEmbedder(body)` wrapper.
- **`dashboard-client/src/tabs/SetupTab.tsx`** — configure buttons (Use Ollama / Use llama.cpp / Use Trigram) that call the route + show the restart-required notice.
- **DELETED `extensions/mega-embed-wizard.ts`** — dead code.

## SAFETY / GUARDRAILS

- PREVENT-PI-004: the route writes a local file only; no network. The Ollama/llama URLs are localhost-only config strings (annotated `guardrails-allow PREVENT-PI-004: localhost-only config string, not a runtime fetch`).
- PREVENT-001: the `readJsonBody` helper type-checks the parsed value (object, not array, not null).
- Shell env wins over the file — the loader never overwrites an existing `process.env` key, so a user's shell profile / inline export always takes precedence.
- Non-fatal: a missing, unreadable, or malformed `.mega-compact.env` is a silent no-op.

## VERIFY

- `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`
- Manual: dashboard Setup → Run Detection → "Use Ollama" → confirm `.mega-compact.env` written → restart pi → confirm `MEGACOMPACT_EMBEDDING_URL` active (SetupTab "Active Embedder" shows httpEmbedder).
- `alreadyActive` path: click "Use Trigram" when already on trigram → response says "Already active — no restart needed."
