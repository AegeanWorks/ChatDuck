# Decisions

Why this project is built the way it is, oldest first. One entry per decision that changes a
contract, a dependency, a data format or the architecture; IDs are consecutive and never reused.

### ADR-001: A static OpenAI-compatible client with browser-local state
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: The chat UI is split out of ModelDuck, whose server and tuner should stay focused. Users also want a fast chat front end that can target Ollama, LM Studio or any OpenAI-compatible server, not only ModelDuck.
- **Decision**: ChatDuck is one static page of dependency-free ES modules behind a tiny Node static server. It uses only `GET /v1/models` and `POST /v1/chat/completions`, and has no backend of its own. Conversations and preferences live in `localStorage`; the API key lives in `sessionStorage` and is forgotten when the tab closes. Markdown is rendered escaping-first, and only `http(s)` links survive. The server binds loopback and refuses paths outside `public/`.
- **Consequences**: The app works with any compatible server and needs no build or install. Because the page and the model server are different origins, ModelDuck must have authentication and CORS enabled. History is per browser, and clearing site data removes it. Streaming depends on the server's SSE support; a non-streaming JSON answer is also read.

### ADR-002: Strip UI-only markers from API history at send time
- **Date**: 2026-11-02
- **Status**: Accepted
- **Context**: Failed requests (`⚠ …`), stopped partials (`_(stopped)_`), empty-answer placeholders, and stored `<think>` blocks stay visible locally for retry/edit context, but `buildMessages` was sending them verbatim on the next turn, wasting tokens and confusing strict or text-only servers.
- **Decision**: `buildMessages` in `public/openai.js` filters assistant turns at send time only: drop `⚠` turns, strip one trailing `_(stopped)_` (skip if empty after), skip the two empty-answer literals, and send `splitThinking(visible)` so stored thinking never reaches the wire. Stored chats, export/import, and retry gating are unchanged.
- **Consequences**: The wire history stays clean on ModelDuck, Ollama, LM Studio, and plain `/v1/chat/completions` endpoints; the dumbest text-only server sees fewer junk tokens and still receives plain strings. Visible markers and statistics are preserved locally.

### ADR-003: Stall timeout aborts hung completions as retryable errors
- **Date**: 2026-11-02
- **Status**: Accepted
- **Context**: A server can accept a request and then never send bytes (cold Ollama/LM Studio loads, flaky networks). ChatDuck waited forever with only manual Stop, leaving a busy composer and a hanging fetch/reader.
- **Decision**: `streamChat` in `public/openai.js` arms a stall timer (default 90000ms for first byte and idle, overridable via `stallTimeoutMs`/`firstByteTimeoutMs`/`idleTimeoutMs`; non-positive disables). Headers and every delta/reasoning/usage reset to the idle budget. The timer aborts an internal controller; user Stop uses the caller `signal`. Timeout normalizes to `TimeoutError("The server stopped responding")` so `runTurn` shows retryable `⚠`, while user abort stays `AbortError` → `_(stopped)_`.
- **Consequences**: Hung ModelDuck/Ollama/LM Studio/plain `/v1/chat/completions` requests fail fast and retryable with no server cooperation; text-only/no-usage/no-models behavior is unchanged. A too-short timeout could cut slow cold loads, so defaults are generous and progress resets the clock.

### ADR-004: First screenshot keepers show the honest unconfigured state
- **Date**: 2026-11-03
- **Status**: Accepted
- **Context**: ChatDuck had approved orbit/CD brand (6/6) but `assets/screenshots/` did not exist and `media.json screenshots: []`; a chat UI cannot show a real reply without a model server, so any conversation capture would be staged.
- **Decision**: Capture `npm start` at `http://127.0.0.1:4173` with no model server running: `2026-11-03-chat.png` (empty library, suggestion cards, composer, Offline status) and `2026-11-03-settings.png` (server URL/key/model/preset/prompt/sampling/library after opening Settings). Record commit `f2c1c0b`, date and viewport 1440x900 in `.aikit/media.json` and the README `aegean:screenshots` block.
- **Consequences**: README proves the real first-run path including the documented ModelDuck connection flow; no reply is shown because none could honestly exist. Reproduce with: `npm start`, open the URL, screenshot, click Settings, screenshot.

### ADR-005: Bracketed raw-text tails survive; only envelope fragments are dropped
- **Date**: 2026-11-03
- **Status**: Accepted
- **Context**: Wave audit of 13 commits found `streamDeltas` tail code dropped any tail starting with `[` or `{` (`if (plain && !/^[[{]/)`), so a server closing without `[DONE]` lost legit answers like `[hello]` or `{hello}` while truncated `{"choices"...` was correctly dropped.
- **Decision**: Keep the tail plain text unless it both starts with `[`/`{` and contains an envelope key (`choices|delta|content|error|usage|message|id|object|model|created`). Truncated envelope fragments still return `""`; legit bracketed raw-text returns intact. Covered by `raw-text tails starting with brackets survive when the stream closes early`.
- **Consequences**: Raw-text ModelDuck/Ollama/LM Studio/plain `/v1/chat/completions` answers that start with brackets are no longer lost on early close; truncated JSON still never leaks framing. A pathological raw-text answer containing an envelope key and starting with a bracket could still be dropped, which is the documented cost of the heuristic.

### ADR-006: Per-chat composer drafts persist locally and clear on send
- **Date**: 2026-11-03
- **Status**: Accepted
- **Context**: Switching chats or reloading the page lost unsent composer text, punishing anyone drafting across conversations. Drafts must never touch the wire, must survive per chat, and must not disturb streaming, thinking-trace handling, rendering, or the session-scoped key.
- **Decision**: Store unsent composer text per chat id in `localStorage` under `chatduck.drafts.v1` (`getDraft`/`setDraft`/`clearDraft`/`clearDrafts` in `public/store.js`, sliced to 20000 chars, corrupt reads as empty, quota failure keeps the live composer value). `public/app.js` saves synchronously on composer input and restores after select/create/delete/import/clear-all/init — never inside `renderAll`, so Send's clear-then-`runTurn` ordering holds. Deleting a chat drops its draft; Clear all drops every draft; duplicates and imports start empty. Attachments are not draft-persisted.
- **Consequences**: Typing survives reloads and chat switches identically on ModelDuck/Ollama/LM Studio/plain `/v1/chat/completions` and the dumbest text-only server, because drafts never leave the browser and never enter `buildMessages`. A reload loses pending file attachments (text restores, files need re-attaching), and typing with no chat at all is not saved until the first Send creates one.

### ADR-007: The settled turn always paints settled; stale streaming frames never win
- **Date**: 2026-11-03
- **Status**: Accepted
- **Context**: A `requestAnimationFrame` queued by the last stream delta could fire after `runTurn.finally`'s `renderAll`, repainting the finished reply streaming-style (thinking forced open, no stats line) until some later render repaired it. The stored message was always correct; only the paint was stale.
- **Decision**: `runTurn.finally` cancels any pending `state.frame` before persist/`renderAll` (deterministic: the synchronous finally block always runs before the next paint), and `updateStreamingMessage` falls back to the full `renderMessages` pass whenever `state.streaming` is null. No API, wire, extraction, rendering, storage, or key-scope changes; no new predicates or tests, because the decision is a one-line branch on live DOM state that node tests cannot execute — the mock-SSE browser protocol is the regression proof.
- **Consequences**: Every completed, stopped, or failed turn settles immediately on ModelDuck/Ollama/LM Studio/plain `/v1/chat/completions` and the dumbest text-only server. A future slip that somehow queues a frame after settle degrades to one redundant full render, never to a wrong paint.

<!-- Entry format:
### ADR-NNN: <decision in one line>
- **Date**: YYYY-MM-DD
- **Status**: Accepted
- **Context**: <what forced the decision>
- **Decision**: <what was decided>
- **Consequences**: <what follows, including what it costs>
-->

### ADR-008: Swarm-verified hardening keeps callbacks and history predicates exact- **Date**: 2026-11-04
- **Status**: Accepted
- **Context**: Parallel analysis swarms (M1-M6) returned file+line+repro findings; sampling reproduced 12 true defects in pure modules: padded model ids, double `onUsage` per answer, missed `message.reasoning_content`, stacked `_(stopped)_` leak, surrogate-split titles, null scroll crash, null/empty index deletes, empty-id chats, shared refs on duplicate, fence closed by ```js.
- **Decision**: Fix exactly the reproduced set with minimal diffs: trim model ids in `listModels`; deliver `onUsage` once (re-emit only when the loop never did) and drop the spurious empty reasoning delta; check `message.reasoning_content` in `reasoningOf`; strip stacked stopped markers in a loop; code-point-safe `titleFrom`; null-safe `isNearBottom`; strict index validation; `id || uuid` generation; deep-clone images/usage on duplicate; `duplicateConversation(null)` returns false; `renameConversation` returns boolean; fence closes only on bare ```. Each fix carries a new `node --test` case (62 to 74 tests).
- **Consequences**: Wire and storage contracts tighten with no migration: existing chats load unchanged, callers passing `Number(index)` are unaffected, and duplicate branches are now safe to explore. Cost: `⚠`-prefixed legit answers, CSP inline-style alignment, and docs/legal gaps are filed-deferred, not fixed here.

### ADR-009: Deferred swarm gaps closed without widening trust
- **Date**: 2026-11-04
- **Status**: Accepted
- **Context**: ADR-008 deferred four verified gaps: table alignment broken by the shipped `style-src 'self'` CSP, legit `⚠`-leading answers culled from wire history, silent `PORT` fallback and raw-stack crashes, and store pure-function gaps (`conversationToJSON(null)` → `"null"`, empty backup unrestorable, token meter counting `"undefined"`).
- **Decision**: Render table alignment with `data-align` attributes plus stylesheet rules (CSP unchanged); drop only assistant turns matching the app's own `⚠ … — fix Settings or press Retry.` error template; parse `PORT` via exported `resolvePort` (unset/blank/0 → 4173, else integer 1-65535, otherwise stderr Why/Fix plus exit 2); `conversationToJSON` throws on invalid input, `conversationsFromJSON` round-trips empty backups with an import-time "Nothing to import." guard, and the token estimate coerces missing fields to empty. Six new `node --test` cases (74 to 80 green).
- **Consequences**: Alignment paints under the shipped CSP with no `unsafe-inline`; legit answers survive on the wire while placeholders stay local; bad ports fail fast with a fix hint; empty backups import cleanly and garbage files still error. Cost: UI `Retry`/`Regenerate` labels and `canRegenerate` still key on the broad `⚠` prefix (cosmetic), and docs/legal wording stays untouched.

### ADR-010: Post-push audit hardens wire, storage, and render edge cases
- **Date**: 2026-11-05
- **Status**: Accepted
- **Context**: Audit of 17 unpushed commits (origin/master `0d2dc69` to `f2e2284`) found 10 small gaps: pasted `/v1/models` endpoint URLs broke `apiUrl`, complete JSON tails with no chat fields vanished, `normalizeMessage` mapped `""` usage to `0`, `{conversations:[]}` backups threw, overlong drafts bypassed the cap on read, `editUserMessage` aliased image arrays, autolinks kept trailing sentence punctuation, `canRegenerate` allowed error retry with no user turn, `resolveStaticPath("/.")` returned the directory, sidebar search assumed string content, and import collisions were only checked against existing chats.
- **Decision**: Strip any trailing `/v1/*` in `normalizeBaseUrl`; surface complete JSON tails verbatim (truncated-envelope filter stays for fragments that fail to parse); align `normalizeMessage` usage nulling with `normalizeUsage`; return `[]` for empty object backups; slice drafts to `MAX_DRAFT_CHARS` on read; copy image arrays on edit; strip trailing `.,;:!?` plus unbalanced `)`/`]` from autolinks; require a user turn for error retry; return `null` for dot-only static paths; coerce sidebar search to strings; dedupe import ids against the batch too. Eight new `node --test` cases (80 to 88 green).
- **Consequences**: Pasted endpoints, bracketed raw-text, empty usage, empty backups, overlong drafts, and duplicate imports behave predictably with no schema migration; existing chats load unchanged. Cost: a model that answers with a complete envelope-shaped JSON object over raw-text is now shown verbatim instead of dropped, which is the documented trade for never losing legit bracketed answers.
