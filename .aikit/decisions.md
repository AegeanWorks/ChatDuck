# Decisions

Why this project is built the way it is, oldest first. One entry per decision that changes a
contract, a dependency, a data format or the architecture; IDs are consecutive and never reused.

### ADR-001: A static OpenAI-compatible client with browser-local state
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: The chat UI is split out of ModelDuck, whose server and tuner should stay focused. Users also want a fast chat front end that can target Ollama, LM Studio or any OpenAI-compatible server, not only ModelDuck.
- **Decision**: ChatDuck is one static page of dependency-free ES modules behind a tiny Node static server. It uses only `GET /v1/models` and `POST /v1/chat/completions`, and has no backend of its own. Conversations and preferences live in `localStorage`; the API key lives in `sessionStorage` and is forgotten when the tab closes. Markdown is rendered escaping-first, and only `http(s)` links survive. The server binds loopback and refuses paths outside `public/`.
- **Consequences**: The app works with any compatible server and needs no build or install. Because the page and the model server are different origins, ModelDuck must have authentication and CORS enabled. History is per browser, and clearing site data removes it. Streaming depends on the server's SSE support; a non-streaming JSON answer is also read.

<!-- Entry format:
### ADR-NNN: <decision in one line>
- **Date**: YYYY-MM-DD
- **Status**: Accepted
- **Context**: <what forced the decision>
- **Decision**: <what was decided>
- **Consequences**: <what follows, including what it costs>
-->
