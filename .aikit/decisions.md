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

<!-- Entry format:
### ADR-NNN: <decision in one line>
- **Date**: YYYY-MM-DD
- **Status**: Accepted
- **Context**: <what forced the decision>
- **Decision**: <what was decided>
- **Consequences**: <what follows, including what it costs>
-->
