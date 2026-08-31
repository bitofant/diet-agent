# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Everything in CLAUDE.md must be extremely terse: bulleted lists, not paragraphs, as concise and token-efficient as possible.**

**Keep this file correct: update it when details change, and add genuinely important architectural decisions as they're made.**

**Code comments must be extremely terse too: short one-liners explaining *why*, never restating the code. No prose blocks, no redundant JSDoc.**

## What this is

- A dieting/food-logging web app. Chat is the *only* input method: the user types what they ate or did in natural language, the app turns it into structured log entries.
- E.g. "just had 2 hot dogs, regular buns, ketchup and mayo" → a `Lunch · 2:10pm · 350 kcal` entry, expandable to per-item calories.
- Editing is natural language too: "I didn't just eat lunch, it was an hour ago" → patches that entry's timestamp. Activities are negative-calorie entries ("just went for a 15min walk", "tracked workout, 460 kcal").
- **Multi-tenant**: many users on one deployment, each with a private log. Nothing is shared or social — no feeds, no comparisons, no aggregate views.
- Mobile-first (phone is the primary device — you log food where you eat it).

## Project state

- **Built: build/test plumbing + all of `shared/`.** Everything else below is intended design, not built. Update this section as slices land.
  - Scaffold: `package.json`, `tsconfig*.json`, `vite.config.ts`, `vitest{,.e2e}.config.ts`, `config.example.json`, `config-gen.sh`. `npm test` + `npm run typecheck` are green.
  - `shared/`: `types.ts`, `dates.ts`, `nutrition.ts`, `actions.ts`, `reduce.ts` — all with co-located tests.
- **Not built yet:** `server/` (nothing — no `index.ts`, `db.ts`, `auth.ts`, `llm/`), `web/` (nothing), no `index.html`, no `config.json` (run `config-gen.sh`).
- Two decisions the code settled, worth knowing before touching `shared/`:
  - **The model never supplies an id.** `add_entry` carries an `EntryDraft` (no `id`/`source`/timestamps); the server fills those via `ReduceContext {now, newId, source}`. Validation rejects an `entry.id` outright.
  - **Validation is the gate; the reducer is total.** `validateActions` is all-or-nothing and resolves every model-supplied id against the user's own day (that resolution *is* the tenant check). `applyAction` then no-ops on unknown ids rather than throwing, so an optimistic client that's briefly behind degrades to "no visible change".
- Same stack as the sibling `../agent-remote` project (React + Vite + Node + TypeScript + SQLite + Vitest, single port, `config.json`); reuse its conventions and its `styles.css` design idiom rather than inventing new ones. It is **not** a dependency — copy patterns, not code, and never import across the folders.
- First vertical slice to aim for: type a meal in chat → LLM returns a structured `add_entry` action → reducer folds it into the day → entry renders in the log, expandable.

## Commands (intended, mirrors agent-remote)

- `npm run dev` — single-process dev server (`tsx watch server/index.ts --dev`), Vite embedded as middleware.
- `npm run build` — production frontend build to `dist/web` (Vite).
- `npm start` — run server serving the prebuilt `dist/web`. **Server is never compiled** — `tsx server/index.ts` directly. Only the frontend is built.
- `npm run typecheck` — `tsc --noEmit` for web (`tsconfig.json`) + server (`tsconfig.server.json`). Both exclude `*.test.ts` so the gate stays scoped to shipping code.
- `npm test` — Vitest run (pure/fast, no network/tokens); `npm run test:watch`. Excludes `*.e2e.test.ts`.
- `npm run test:e2e` — live tests against a local OpenAI-compatible endpoint (vLLM); self-skip when unreachable. Kept out of `npm test`.
- Requires `config.json` (see Config).

## Architecture (settled)

- **Frontend:** React + Vite, TypeScript. Mobile-first, no CSS framework.
- **Backend:** Node + TypeScript, run via `tsx` (never compiled). SQLite via `better-sqlite3`.
- **Single port:** UI, `/api` and `/ws` on one port (default **4100** — 4000 is agent-remote). Dev embeds Vite in **middleware mode** in the Node server (`--dev` flag, not env); prod serves `dist/web`. `/ws` and Vite HMR coexist via `noServer` + manual `upgrade` routing.
- **The LLM never touches the database.** It only emits **typed actions** (`LogAction[]`) which the server validates and a **pure reducer** applies to the day. This is the load-bearing decision: it keeps the whole interesting surface (parse → action → new day state) testable without tokens, makes every edit undoable/auditable, and keeps a hallucinated field from corrupting the log. Never let a prompt result write SQLite directly.
- **`shared/` is the contract**, imported by both sides: entry/day types, the action vocabulary, and the reducer. Same code runs server-side (authoritative state) and client-side (optimistic updates), exactly as agent-remote folds `ChatEvent`s on both ends.
- **Days are local-day keyed** (`YYYY-MM-DD`), never UTC timestamps. The *client* supplies its `now` + IANA timezone with every chat turn; the server never assumes its own clock is the user's day. "Today"/"yesterday" in the sidebar and "an hour ago" in a prompt both resolve against that.
- **Hard constraint:** LLM-specific and prompt-specific logic stays in `server/llm/`. The reducer, storage, protocol and UI must stay model-agnostic — swapping the model or provider must not touch them.
- **Hard constraint:** multi-tenant isolation, enforced in `db.ts`. See Multi-tenancy & privacy below — read it before adding any route, query or cache.

## Data model (shared/types.ts)

- `DayLog { date: "YYYY-MM-DD", entries: LogEntry[], targetKcal? }` — derived totals are computed, never stored.
- `LogEntry { id, kind: "meal"|"activity"|"note"|"weight", at: ISO, label, items: LogItem[], note?, source, createdAt, updatedAt }`
  - `label` is display text ("Lunch", "Morning walk") — free-form, **not** an enum; the model picks it from the meal time and content.
  - `source` = the raw user message that created it, kept for debugging bad parses and for re-parsing later.
- `LogItem { name, qty?, unit?, kcal, protein?, carbs?, fat? }` — per-item kcal is what makes the tap-to-expand view work. Entry kcal = sum of items (never a separate field that can drift).
- **Activities are entries with negative `kcal` items**, not a parallel concept. One timeline, one sum. `kind` only drives the glyph/grouping.
- `ChatMessage { id, role, text, at, entryIds?: string[] }` — assistant turns cite the entries they created/edited so the UI can highlight them.

## Action vocabulary (shared/actions.ts)

- The LLM's whole output surface. Keep it small and orthogonal; each is validated (unknown ids, NaN kcal, out-of-range dates rejected) before the reducer sees it.
  - `add_entry {entry}` · `update_entry {id, patch}` · `delete_entry {id}`
  - `add_item {entryId, item}` · `update_item {entryId, index, patch}` · `remove_item {entryId, index}`
  - `answer {text}` — a question, not a mutation ("how many calories left today?"). Always allowed to accompany mutations.
  - `clarify {question}` — the model is unsure; ask instead of guessing. Prefer this over inventing quantities.
- **`update_entry` over delete+add.** Re-creating an entry loses its id, its position and the user's expanded state; "it was an hour ago" must patch `at`.
- **Log every turn's raw model output** (`llm_turns` table) alongside the parsed actions. The user's query space is not yet known — this log is how the prompt gets improved. Add a rejected-action counter to it, not to a separate table.
- **Adding an action kind is a TDD moment**: write the reducer test first, then the schema/prompt, then run it live against the local endpoint and adjust the test to what the model really emits, then build the UI. Same order agent-remote uses for new `ChatEvent` kinds.

## Layout (intended)

- `shared/` — `types.ts` (entries/days), `actions.ts` (action vocabulary + validation), `reduce.ts` (pure `applyAction(day, action) → day`), `nutrition.ts` (totals/derived math), `dates.ts` (local-day keys, "today/yesterday" labelling, relative-time resolution).
- `server/` — `index.ts` (HTTP + WS + dev Vite), `db.ts` (SQLite: users, auth sessions, days, entries, chat messages, llm turns — every user-owned accessor takes `userId` first, see Multi-tenancy), `auth.ts`, `config.ts`, `llm/` (client + prompt + action decoding), `api.ts` (day read/write routes).
- `web/` — `App.tsx` (sidebar + main pane), `DayView.tsx` (the chat/log timeline), `EntryCard.tsx` (collapsed summary → expanded item list), `Composer.tsx`, `History.tsx`, `Settings.tsx`, `client.ts` (WS + optimistic apply), `theme.ts`, `styles.css`.
- Co-located `*.test.ts`, Node environment. First and most valuable coverage is `shared/` — it's pure, so it's free to test.

## UI

- **Sidebar:** Today · Yesterday · Day before yesterday · History · Settings. The three day rows are computed from the *client's* local date, relabelled at midnight — never hardcoded to a stored date. Each shows its kcal total vs target. On mobile it's a drawer.
- **Main view is one interleaved timeline**, chat and log in the same scroll, ordered by time: user messages, assistant replies, and entry cards. Not two panes, not tabs — the log *is* the conversation's result and reading them apart loses the "why did it say 350?" thread.
- **Entry card:** collapsed = `label · time · kcal`. Tap expands to the per-item breakdown (name, qty, kcal). Expansion is local UI state keyed by entry id, never stored.
- **Editing is chat-first**, but the expanded card also allows direct edits (time, item kcal, delete). Both funnel through the *same* `LogAction`s — the manual path constructs the action client-side rather than a second write path. Any second write path will drift.
- **Composer** is always visible and focused-on-open; Enter sends. Show the pending turn optimistically (user bubble immediately, entry card when the actions land).
- History = scrollable list of past days (date, total, target, over/under), tapping one opens that day read-write in the same timeline view.
- Settings = daily kcal target, timezone, units (kcal/kJ, metric/imperial), macro display on/off, model/endpoint choice.

## Theming (carry over from agent-remote — it's a settled idiom, don't reinvent)

- The palette is **12 CSS vars + a 3-step radius scale in `styles.css`'s `:root`** and nothing else: `--bg`/`--panel`/`--raised`, `--text`/`--muted`, `--accent`/`--on-accent`, `--success`/`--warning`/`--danger`/`--danger-hover`/`--on-danger`. Adding a color = add a var + a `THEME_VARS` entry in `web/theme.ts`. **Never hardcode a hex or a raw radius in a component or rule.**
- **Elevation, not outlines.** There is **no border colour in the palette**: surfaces separate by three background steps (`--bg` < `--panel` < `--raised`) plus a shadow on floating things. **Nested content must rise, never sink** — a `--bg` fill inside a `--panel` card is the "sunken well" bug that reads as dated. State rules (hover/active/selected) use an accent tint (`color-mix(… var(--accent) 10–20%, var(--raised))`), not a darker fill. The only legitimate darkening is a momentary `:active` press. **Adding a divider is the wrong reflex — change the elevation instead.**
- Surviving `border` declarations must be **signal, never structure** (e.g. a danger ring on an over-target day).
- **Controls are filled, never outlined.** Every button/input/select/textarea/row is a `--raised` fill with no border. Deleting a `border` rule is *not* the same as having none — the UA falls back to `border-style: outset` (a Win-98 bevel), so ship a base `button,input,select,textarea { border: none }` reset. `select` also needs `appearance: none` (else it draws native chrome and ignores your background), which costs the arrow — redraw it as a CSS **mask** filled with `var(--muted)`, never a `background-image` SVG (that hardcodes the colour).
- Focus can't ride on a border: `:focus` → a `box-shadow` ring (`0 0 0 2px` accent color-mix — a ring can't shift layout), `:hover` → 10% accent tint, `.active`/`.selected` → 20%. **Any new control needs a non-border focus indicator**; pairing `outline:none` with nothing is invisible.
- **Radius scale is `--r-sm`/`--r-md`/`--r-lg` (4/8/12px)** and nested boxes stay **concentric**: `inner = outer − padding`. A `--r-lg` box with 8px padding takes `--r-sm` inside; off-scale values make curves look non-parallel.
- Touch has no hover: secondary affordances (delete, edit glyphs) sit at a permanent low opacity (~.3–.4), **never hover-only**.

## Mobile

- Size `.app` to `visualViewport.height` when the keyboard is up and float the composer above it; `index.html` sets `interactive-widget=resizes-content`. Together these stop the page being panned under the keyboard — don't revert without re-checking.
- This app is used one-handed while eating. Composer and day switcher must be reachable at the bottom of the screen.

## LLM integration

- `server/llm/` talks to an **OpenAI-compatible endpoint** (`config.json` `llm` block; default local vLLM at `http://localhost:8000/v1`), so a local model can be used for development and e2e tests at zero token cost. A hosted provider is a config change, not a code change.
- The turn is: `{recent day state + recent chat + client now/tz + user message}` → model → **strict JSON `{actions: [...]}`** (structured output / tool-calling where the endpoint supports it) → validate → reduce → broadcast.
- Send the model the *current day's entries with their ids*. Without them "the lunch entry" cannot be resolved to an `update_entry`.
- **Fail safe.** An unreachable endpoint, malformed JSON, or an action that fails validation must surface as an assistant message ("I couldn't parse that — try...") and change nothing. Never partially apply a batch: validate all actions, then apply all, or none.
- Calorie numbers come from the model's own knowledge for now. A food database (USDA FDC / OpenFoodFacts) is the obvious later upgrade — keep `LogItem` shaped so a `source`/`fdcId` field can be added without a migration of meaning.
- **Don't over-fit the prompt to today's example phrasings.** The full query space is unknown; prefer a small orthogonal action set + `clarify` over special-casing intents.

## Testing

- **Vitest**, co-located `*.test.ts`, Node environment. Pure `shared/` logic is the first and hardest gate: reducer, validation, date/local-day math, totals. No DOM, no network, no tokens.
- `*.e2e.test.ts` (separate `vitest.e2e.config.ts`) drive the **real** LLM path against local vLLM and self-skip when it's unreachable: "2 hot dogs..." → an `add_entry` with plausible items; "it was an hour ago" → an `update_entry` patching `at` on the right id. Assert the **deterministic** part (which action, which field, which id) hard; treat the model's kcal figures as a soft/range check. Run e2e files serially — one local endpoint must not be hammered concurrently.
- Prefer TDD for anything with an observable contract: a new action kind, a new derived total, timezone/DST edge cases.

## Config

- No env variables. All config lives in `config.json` (gitignored), shape in `config.example.json`, generated by `config-gen.sh`.
- Keys: `llm` (`provider`/`baseUrl`/`model`/`apiKey?`), `server.port`, `defaults` (kcal target, units).
- Never reintroduce `process.env`-style config or `.env` files.

## Multi-tenancy & privacy (hard constraint)

**The app is multi-tenant and the data is health data. No user data is reachable without being logged into that user's account — this outranks every other concern in this file. When a feature and this rule conflict, the feature loses.**

- **Authentication:** the whole app is login-gated. `server/auth.ts` owns all of it — scrypt password hashing (`salt:hash`), server-side session tokens in SQLite, set as an **HttpOnly** (+ `Secure` in prod, `SameSite=Lax`) cookie, never exposed to page JS. The rest of the server only asks "who is this request?" via `authedUser()`. Every `/api` route and the `/ws` upgrade is gated on it — **default-deny**: a new route is unreachable until it opts in, never the reverse. Keep auth concerns in `auth.ts`; the rest of the code stays auth-agnostic.
- **Scope at the persistence boundary, never at the call site.** Every user-owned table has a `user_id` column, and every `db.ts` accessor takes `userId` as its **first argument** and puts it in the `WHERE` clause. Do not add an unscoped `getEntry(id)` "just for internal use" — one such helper is all it takes, and agent-remote already learned this shape of lesson with folder normalization: enforce it where the data is read, not in each caller that remembers to.
- **An id from the client is never authorization.** Ownership is proven by the `WHERE user_id = ?` on the same statement that fetches the row — not by a separate fetch-then-compare (forgettable, and a TOCTOU). A wrong/guessed id yields **404, never 403** — a 403 confirms the row exists.
- **The user comes from the session cookie, never from the request.** No `?user=`, no user id in a path or body, no client-supplied tenant hint anywhere. If a handler reads a user id from input, that's a bug regardless of what it then checks.
- **Action validation is tenant validation.** `update_entry`/`delete_entry`/`add_item` carry ids the *model* produced from *some* context — resolve every one against the requesting user's own day before the reducer runs, and reject the whole batch if any fails.
- **LLM requests carry exactly one user's data.** Never batch or cache across users; the prompt is built from the requesting user's day and chat only. A shared/global cache keyed by anything but `(userId, …)` is a leak.
- **Sending food logs to a hosted model is third-party disclosure of health data.** The local endpoint default exists partly for this. If a hosted provider is configured, that's a deliberate deployment choice — say so in the README/settings, don't bury it.
- **Logs and diagnostics are user data too.** `llm_turns` (raw prompts + model output) is the most sensitive table in the app: owned, scoped, and pruned like the rest. Never write entry text, prompts or model output to stdout/journald at any level above debug — the systemd journal is not access-controlled the way the DB is.
- **Cross-tenant access is a required test case, not a nice-to-have.** Every read/write path gets a test that a second user's id cannot reach the first user's day, entry, chat message or llm turn — the analogue of agent-remote pinning path confinement in `files.test.ts`. Add the test with the route, in the same commit.
- **Account deletion cascades** (days, entries, chat, llm turns, sessions) and export gives a user their own data back. Design the schema with `ON DELETE CASCADE` from the start; retrofitting it is a migration.

## Deployment (later)

- Same shape as agent-remote: a **systemd user service** (`install-service.sh` writes/enables the unit, `npm start`, linger on), with `start.sh`/`stop.sh`/`restart.sh`/`rebuild.sh` wrappers.
- If that's adopted, carry over the restart-resilience lessons: `rebuild.sh` **stages + atomically swaps** (`vite build --outDir dist/web.next` → `mv`) so a live server never reads a half-emptied `dist/web`; the static handler try/catches its read → 503; the unit gets `Restart=always` + `StartLimitIntervalSec=0`.
- Unlike agent-remote, the agent does **not** run inside this app, so restarting the service here is safe.
