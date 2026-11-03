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

<!-- Entry format:
### ADR-NNN: <decision in one line>
- **Date**: YYYY-MM-DD
- **Status**: Accepted
- **Context**: <what forced the decision>
- **Decision**: <what was decided>
- **Consequences**: <what follows, including what it costs>
-->
