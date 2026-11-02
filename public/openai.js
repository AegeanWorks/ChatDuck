/**
 * A small, dependency-free OpenAI-compatible client. It speaks only the
 * documented `/v1/models` and `/v1/chat/completions` endpoints, parses SSE
 * without a library, and keeps every helper pure enough to test in Node.
 */

/** The server root without a trailing slash or `/v1`, so paths append cleanly. */
export function normalizeBaseUrl(input) {
  const value = String(input ?? "").trim();
  if (!value) throw new Error("Enter a server URL, for example http://127.0.0.1:4141.");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("That server URL is not valid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The server URL must start with http or https.");
  }
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/v1")) pathname = pathname.slice(0, -3);
  return `${url.origin}${pathname}`.replace(/\/+$/, "");
}

export function apiUrl(baseUrl, pathname) {
  return `${normalizeBaseUrl(baseUrl)}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

export function requestHeaders(apiKey) {
  return {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

/** Data-URL images attached to a user turn (downscaled JPEG/PNG in the UI). */
export function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter((image) => typeof image === "string" && image.startsWith("data:image/"))
    .slice(0, 4);
}

/**
 * Vision-capable content parts: plain text stays a string for text-only
 * servers, while turns with images use OpenAI content parts.
 */
export function contentParts(text, images = []) {
  const clean = normalizeImages(images);
  const body = String(text ?? "");
  if (!clean.length) return body;
  const parts = [];
  if (body.trim()) parts.push({ type: "text", text: body });
  for (const url of clean) parts.push({ type: "image_url", image_url: { url } });
  return parts.length ? parts : body;
}

/** UI-only assistant markers that stay visible locally but never reach the server. */
const STOPPED_SUFFIX = "_(stopped)_";
const EMPTY_ANSWER_MARKERS = new Set([
  "_(the server returned an empty answer)_",
  "_(the server returned reasoning without a final answer)_",
]);

/** Strip one trailing stopped marker, reversing runTurn's `_(stopped)_` suffix. */
function withoutStoppedMarker(text) {
  const body = String(text ?? "");
  if (body.endsWith(`\n\n${STOPPED_SUFFIX}`)) return body.slice(0, -(`\n\n${STOPPED_SUFFIX}`.length));
  if (body.endsWith(STOPPED_SUFFIX)) return body.slice(0, -STOPPED_SUFFIX.length);
  return body;
}

/** The messages the API receives: an optional system prompt, then the conversation. */
export function buildMessages({ systemPrompt = "", messages = [] } = {}) {
  const out = [];
  if (String(systemPrompt).trim()) out.push({ role: "system", content: String(systemPrompt).trim() });
  for (const message of messages) {
    if (!message || !["user", "assistant"].includes(message.role)) continue;
    const images = message.role === "user" ? normalizeImages(message.images) : [];
    const text = typeof message.content === "string" ? message.content : "";
    if (message.role === "assistant") {
      // Error placeholders are retryable UI state, not conversation context.
      if (text.trimStart().startsWith("⚠")) continue;
      const unstopped = withoutStoppedMarker(text);
      // Empty-answer placeholders keep the bubble from looking broken locally.
      if (EMPTY_ANSWER_MARKERS.has(unstopped.trim())) continue;
      // Stored <think> blocks (imports/legacy) render clean but must send clean too.
      const visible = splitThinking(unstopped).visible;
      const empty = !String(visible ?? "").trim();
      if (empty) continue;
      out.push({ role: "assistant", content: visible });
      continue;
    }
    const content = contentParts(text, images);
    const empty = typeof content === "string" ? !content.trim() : !content.length;
    if (empty) continue;
    out.push({ role: message.role, content });
  }
  return out;
}

/** Caps for text-file attachments: count per message and chars per file. */
export const MAX_TEXT_FILES = 3;
export const MAX_TEXT_ATTACH_CHARS = 12000;
/** Raw read cap so a huge log cannot freeze the tab before truncation. */
export const MAX_TEXT_READ_BYTES = 200000;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "jsonl", "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "c", "h", "cpp", "hpp", "cs", "php", "swift",
  "kt", "html", "htm", "css", "scss", "xml", "yml", "yaml", "toml", "ini", "cfg",
  "sh", "bash", "sql", "csv", "tsv", "log", "diff", "patch", "tex", "vue", "svelte",
]);

/** Lowercase extension of a file name, without the dot. */
export function attachmentExtension(name) {
  const base = String(name ?? "").split(/[?#]/)[0].split("/").pop();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** True for plain-text files the chat can inline (images go through vision). */
export function isTextFile(file) {
  if (!file) return false;
  const type = String(file.type ?? "");
  if (type.startsWith("text/") || type === "application/json") return true;
  if (type.startsWith("image/")) return false;
  return TEXT_EXTENSIONS.has(attachmentExtension(file.name));
}

/** Inline a text file as a labeled fenced block, truncated to the char cap. */
export function wrapTextAttachment(name, content) {
  const safeName = String(name ?? "file").slice(0, 120) || "file";
  const body = String(content ?? "");
  const truncated = body.length > MAX_TEXT_ATTACH_CHARS
    ? `${body.slice(0, MAX_TEXT_ATTACH_CHARS)}\n…(truncated ${body.length - MAX_TEXT_ATTACH_CHARS} more chars)`
    : body;
  const fence = attachmentExtension(safeName);
  return `**Attached file: ${safeName}**\n\`\`\`${fence}\n${truncated}\n\`\`\``;
}

/** Rough token estimate (~4 chars/token) for composer counters and stats. */
export function estimateTokens(text) {
  const length = String(text ?? "").length;
  if (!length) return 0;
  return Math.max(1, Math.ceil(length / 4));
}

/** Split `<think>`/`<thinking>` blocks (Qwen/DeepSeek style) from visible content. */
export function splitThinking(content) {
  const text = String(content ?? "");
  const pattern = /<(?:think|thinking|reasoning)[^>]*>([\s\S]*?)(?:<\/(?:think|thinking|reasoning)>|$)/gi;
  let thinking = "";
  const visible = text.replace(pattern, (_match, inner) => {
    thinking += (thinking ? "\n\n" : "") + String(inner ?? "").trim();
    return "";
  }).trim();
  if (!thinking) return { thinking: "", visible: text };
  return { thinking: thinking.trim(), visible };
}

/** Extract a reasoning delta from providers that send it outside `content`. */
export function reasoningOf(choice) {
  const delta = choice?.delta ?? choice?.message ?? {};
  const candidates = [
    delta?.reasoning_content,
    delta?.reasoning,
    choice?.reasoning_content,
    choice?.reasoning,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return "";
}

/** Complete `data:` events in an SSE buffer, and the unfinished tail. */
export function parseSseChunk(buffer) {
  const events = [];
  // SSE allows CRLF; normalize so an event split across chunks still parses.
  let rest = String(buffer ?? "").replace(/\r\n/g, "\n");
  let index;
  while ((index = rest.indexOf("\n\n")) >= 0) {
    const block = rest.slice(0, index);
    rest = rest.slice(index + 2);
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^\s/, ""))
      .join("\n");
    if (data) events.push(data);
  }
  return { events, rest };
}

async function responseError(response) {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text);
    const info = body?.error ?? {};
    return info.why ? `${info.message ?? "Request failed"} — ${info.why}` : info.message ?? `Request failed (${response.status})`;
  } catch {
    return text.trim() || `Request failed (${response.status})`;
  }
}

async function* streamDeltas(response) {
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = await response.json();
    const message = body?.choices?.[0]?.message ?? {};
    const reasoning = reasoningOf(body?.choices?.[0] ?? {});
    if (reasoning) yield { reasoning };
    const content = message?.content;
    if (typeof content === "string" && content) yield { delta: content };
    else if (Array.isArray(content)) {
      const text = content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
      if (text) yield { delta: text };
    }
    const usage = body?.usage;
    if (usage) yield { usage };
    return;
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseChunk(buffer);
    buffer = parsed.rest;
    for (const data of parsed.events) {
      if (data === "[DONE]") return;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        // Raw-text SSE (no JSON envelope): keep the words instead of
        // showing nothing until the stream closes.
        if (data) yield { delta: data };
        continue;
      }
      if (event?.error) {
        const info = event.error;
        throw new Error(info.why ? `${info.message ?? "The server reported an error"} — ${info.why}` : info.message ?? "The server reported an error");
      }
      const choice = event?.choices?.[0];
      const reasoning = reasoningOf(choice);
      if (reasoning) yield { reasoning };
      const raw = choice?.delta?.content ?? choice?.message?.content;
      const delta = Array.isArray(raw)
        ? raw.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
        : raw;
      if (typeof delta === "string" && delta) yield { delta };
      if (event?.usage) yield { usage: event.usage };
    }
  }
  const tail = String(buffer ?? "").trim();
  if (tail) {
    // Some servers close without [DONE]; try one last JSON event.
    const compact = tail.replace(/^data:\s*/, "");
    if (compact && compact !== "[DONE]") {
      try {
        const event = JSON.parse(compact);
        const choice = event?.choices?.[0];
        const reasoning = reasoningOf(choice);
        if (reasoning) yield { reasoning };
        const delta = choice?.delta?.content ?? choice?.message?.content;
        if (typeof delta === "string" && delta) yield { delta };
      } catch {
        // Plain-text tail: strip SSE framing, but drop fragments that look
        // like truncated JSON instead of leaking protocol syntax.
        const plain = tail
          .split("\n")
          .map((line) => line.replace(/^data:\s?/, "").trim())
          .filter((line) => line && line !== "[DONE]")
          .join("\n")
          .trim();
        if (plain && !/^[[{]/.test(plain)) yield { delta: plain };
      }
    }
  }
}

/** Normalize a server `usage` block to finite token counts (or nulls). */
export function normalizeUsage(usage) {
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  if (!usage || typeof usage !== "object") return null;
  const prompt = number(usage.prompt_tokens);
  const completion = number(usage.completion_tokens);
  const fallback = prompt !== null && completion !== null ? prompt + completion : null;
  const total = usage.total_tokens === undefined || usage.total_tokens === null ? fallback : number(usage.total_tokens);
  if (prompt === null && completion === null && total === null) return null;
  return { prompt, completion, total };
}

/**
 * Stream a chat completion. `onDelta(delta, fullText)` is called for each text
 * piece; `onReasoning(delta, fullReasoning)` for thinking traces and
 * `onUsage(usage)` when the server reports token counts. Extra params
 * (topP, penalties, seed) are omitted when unset so strict servers keep
 * working. Pass `stream: false` for a single non-streaming answer (some
 * servers only support one mode). The full answer text is returned as a
 * plain string. Abort with `signal`. A stall timeout aborts hung servers:
 * `stallTimeoutMs` (default 90000) covers time to first progress and idle
 * time between progress events; any delta, reasoning, usage, or headers
 * reset it. `firstByteTimeoutMs`/`idleTimeoutMs` override each phase.
 * A timeout throws a `TimeoutError` (retryable), never an `AbortError`
 * (which stays reserved for user Stop/Esc).
 */
export async function streamChat({ baseUrl, apiKey = "", model, messages, temperature = 0.7, maxTokens = 1024, topP = null, frequencyPenalty = 0, presencePenalty = 0, seed = null, stream = true, signal, stallTimeoutMs = 90000, firstByteTimeoutMs = null, idleTimeoutMs = null, fetchImpl = fetch, onDelta = () => {}, onReasoning = () => {}, onUsage = () => {} }) {
  const payload = { model, messages, stream: stream !== false, temperature, max_tokens: maxTokens };
  if (topP !== null && topP !== undefined && topP !== "") payload.top_p = Number(topP);
  if (Number(frequencyPenalty)) payload.frequency_penalty = Number(frequencyPenalty);
  if (Number(presencePenalty)) payload.presence_penalty = Number(presencePenalty);
  if (seed !== null && seed !== undefined && seed !== "") payload.seed = Number(seed);
  const firstMs = Number(firstByteTimeoutMs ?? stallTimeoutMs);
  const idleMs = Number(idleTimeoutMs ?? stallTimeoutMs);
  const validMs = (value) => Number.isFinite(value) && value > 0;
  // One controller for the fetch so user Stop and the stall timer share it,
  // but a flag keeps their errors distinct for the UI.
  const combined = new AbortController();
  let timedOut = false;
  let timer = null;
  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const arm = (ms) => {
    clearTimer();
    if (!validMs(ms)) return;
    timer = setTimeout(() => {
      timedOut = true;
      try {
        combined.abort(new DOMException("stall timeout", "TimeoutError"));
      } catch {
        try {
          combined.abort();
        } catch {
          // Ignore abort failures; the catch below still maps via timedOut.
        }
      }
    }, ms);
    if (typeof timer.unref === "function") {
      try {
        timer.unref();
      } catch {
        // Browsers have no unref; ignore.
      }
    }
  };
  const onUserAbort = () => {
    try {
      combined.abort(signal?.reason);
    } catch {
      // Ignore; the original signal already carries the AbortError.
    }
  };
  try {
    signal?.addEventListener?.("abort", onUserAbort, { once: true });
    if (signal?.aborted) onUserAbort();
    arm(firstMs);
    const response = await fetchImpl(apiUrl(baseUrl, "/v1/chat/completions"), {
      method: "POST",
      headers: requestHeaders(apiKey),
      body: JSON.stringify(payload),
      signal: combined.signal,
    });
    if (!response.ok) throw new Error(await responseError(response));
    // Headers are first progress: switch from first-byte to idle budget.
    arm(idleMs);
    const poke = () => arm(idleMs);
    const wrappedDelta = (delta, full, info) => {
      poke();
      onDelta(delta, full, info);
    };
    const wrappedReasoning = (delta, full) => {
      poke();
      onReasoning(delta, full);
    };
    const wrappedUsage = (usage) => {
      poke();
      onUsage(usage);
    };
    let text = "";
    let reasoning = "";
    let usage = null;
    for await (const part of streamDeltas(response)) {
      if (combined.signal.aborted && timedOut) break;
      if (part.usage) {
        usage = normalizeUsage(part.usage);
        if (usage) wrappedUsage(usage);
        continue;
      }
      if (part.reasoning) {
        reasoning += part.reasoning;
        wrappedReasoning(part.reasoning, reasoning);
        continue;
      }
      if (typeof part.delta === "string" && part.delta) {
        text += part.delta;
        wrappedDelta(part.delta, text, { reasoning, usage });
      }
    }
    if (timedOut) {
      const timeoutError = new Error("The server stopped responding");
      timeoutError.name = "TimeoutError";
      throw timeoutError;
    }
    // Inline <think> fallback: some models stream reasoning inside the content.
    if (!reasoning) {
      const split = splitThinking(text);
      if (split.thinking) {
        text = split.visible;
        reasoning = split.thinking;
      }
    }
    // Keep the return value a plain string so existing callers and tests keep
    // working; reasoning/usage flow through the callbacks and the last call.
    if (reasoning) wrappedReasoning("", reasoning);
    if (usage) wrappedUsage(usage);
    return text;
  } catch (error) {
    // Our timer is the only source of TimeoutError: normalize any abort it
    // caused (reader AbortError, DOMException, etc.) to one retryable error
    // so runTurn shows ⚠ Retry instead of _(stopped)_.
    if (timedOut) {
      if (error?.name === "TimeoutError" && /stopped responding/.test(String(error?.message))) throw error;
      const timeoutError = new Error("The server stopped responding");
      timeoutError.name = "TimeoutError";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimer();
    try {
      signal?.removeEventListener?.("abort", onUserAbort);
    } catch {
      // Ignore cleanup failures.
    }
  }
}

/** The model ids the server lists. */
export async function listModels({ baseUrl, apiKey = "", fetchImpl = fetch }) {
  const response = await fetchImpl(apiUrl(baseUrl, "/v1/models"), { headers: requestHeaders(apiKey) });
  if (!response.ok) throw new Error(await responseError(response));
  const body = await response.json();
  return Array.isArray(body?.data) ? body.data.map((model) => String(model.id)).filter(Boolean) : [];
}

/** A conversation title from the first user line. */
export function titleFrom(text, limit = 48) {
  const line = String(text ?? "").split("\n").map((item) => item.trim()).find(Boolean) ?? "New chat";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** Ask the model for a short chat title (best-effort; callers keep the old title on failure). */
export async function suggestTitle({ baseUrl, apiKey = "", model, userText = "", fetchImpl = fetch } = {}) {
  const text = await streamChat({
    baseUrl,
    apiKey,
    model,
    messages: [
      { role: "system", content: "Name this chat in 6 words or fewer. Reply with only the title, no quotes." },
      { role: "user", content: String(userText ?? "").slice(0, 500) },
    ],
    temperature: 0.3,
    maxTokens: 32,
    stream: false,
    fetchImpl,
    onDelta: () => {},
    onReasoning: () => {},
    onUsage: () => {},
  });
  return titleFrom(String(text).replace(/^["']+|["']+$/g, "").trim());
}
