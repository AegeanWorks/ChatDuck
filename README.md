# ChatDuck

[![Built with AIKit](https://img.shields.io/badge/built%20with-AIKit-6f42c1)](https://github.com/AegeanWorks/AIKit)

A fast, local-first web chat UI for any OpenAI-compatible model server, including ModelDuck. It is one static page and a few modules: no build step, no framework, no backend, and no telemetry.

## ⚡ 30-Second Cold-Start Quick Reference

- **Runtime Prerequisites**: Node.js 20 or newer (only to serve the static files and run the tests). A browser with `fetch` and `ReadableStream`. No `npm install` is needed.
- **Start it with one click (Windows)**: double-click **`start.bat`**. It starts
  the local server and opens ChatDuck in your browser.
  On macOS/Linux run `npm run start:open`, or `npm start` and open
  **http://127.0.0.1:4173** yourself.
  Then open **Settings** and enter your server URL, model and API key.
- **Canonical Regression Shield Gate**:
  ```bash
  npm test
  ```

### Connect to ModelDuck

1. Start ModelDuck (`npm start -- --no-open --port 4141`) and load a model.
2. In ModelDuck **Settings → Server**, turn on **Require authentication** and **Enable CORS** (CORS needs authentication), then create an API key.
3. In ChatDuck **Settings**, set **Server URL** to `http://127.0.0.1:4141`, paste the key, and pick the model from the list (or type it).

ChatDuck is served from `127.0.0.1:4173`, so the browser treats `127.0.0.1:4141` as another origin; that is why CORS is needed. The same settings work with Ollama, LM Studio or any other server that implements `GET /v1/models` and `POST /v1/chat/completions`.

## What it does

- Streams answers token by token, with **Stop** and copyable code blocks.
- Renders Markdown safely: raw HTML is escaped, only `http(s)` links become links.
- Keeps chats and search in this browser (`localStorage`); the API key stays in `sessionStorage` and is forgotten when the tab closes.
- Lists models from `/v1/models`, remembers the server URL and model, and supports a custom system prompt, temperature and max tokens.
- Works with one or several servers by changing the URL in Settings.
- Light and dark themes, a responsive sidebar, and no network requests except to the server you configure.

## Privacy and security

ChatDuck has no backend and sends nothing anywhere except the server URL you enter. Conversations are stored in this browser only. The API key is session-scoped. Rendered model output is escaped first; links are limited to `http` and `https`. Clearing site data removes local chats and settings.

## 📦 What's Inside

```text
chatduck/
├── .gitignore
├── LICENSE
├── COMMERCIAL.md
├── LICENSES/
├── REUSE.toml
├── public/
│   ├── index.html   <- one page: sidebar, chat, settings
│   ├── app.js       <- state, streaming, chat list, settings
│   ├── openai.js    <- /v1 client, SSE parsing, errors
│   ├── store.js     <- settings and conversation storage rules
│   ├── markdown.js  <- escaping-first Markdown renderer
│   ├── favicon.svg  <- the duck mark
│   └── styles.css   <- responsive dark/light theme
├── scripts/
│   └── serve.mjs    <- dependency-free static server
├── tests/
│   ├── openai.test.js
│   ├── markdown.test.js
│   ├── store.test.js
│   └── serve.test.js
├── package.json
├── README.md
├── start.bat       <- one-click Windows launcher
└── .aikit/          <- this project's memory: ledger and decisions
```

## Development

```bash
npm start          # serve http://127.0.0.1:4173
npm run start:open # serve and open the browser (used by start.bat)
npm run dev        # restart when files change
npm test           # client, storage, Markdown and static-server tests
```

## AIKit Commands (run from the AIKit folder)

| Role | Command |
|---|---|
| Status, task and gates | `python aikit.py status chatduck` |
| Phase 4: every gate | `python aikit.py check chatduck` |
| Repair memory and map, then check | `python aikit.py fix chatduck` |
| Resume an interrupted task | `python aikit.py resume chatduck` |

## License

Free for personal use under the Aegean License 1.1 (AL-1.1); see [LICENSE](LICENSE). Any commercial use needs the Aegean Commercial License 1.0 (ACL-1.0); see [COMMERCIAL.md](COMMERCIAL.md).
