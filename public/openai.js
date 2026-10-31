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

/** The messages the API receives: an optional system prompt, then the conversation. */
export function buildMessages({ systemPrompt = "", messages = [] } = {}) {
  const out = [];
  if (String(systemPrompt).trim()) out.push({ role: "system", content: String(systemPrompt).trim() });
  for (const message of messages) {
    if (!message || !["user", "assistant"].includes(message.role)) continue;
    if (typeof message.content !== "string" || !message.content.trim()) continue;
    out.push({ role: message.role, content: message.content });
  }
  return out;
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
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content === "string" && content) yield content;
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
        continue;
      }
      if (event?.error) {
        const info = event.error;
        throw new Error(info.why ? `${info.message ?? "The server reported an error"} — ${info.why}` : info.message ?? "The server reported an error");
      }
      const delta = event?.choices?.[0]?.delta?.content ?? event?.choices?.[0]?.message?.content;
      if (typeof delta === "string" && delta) yield delta;
    }
  }
}

/**
 * Stream a chat completion. `onDelta(delta, fullText)` is called for each piece;
 * the full answer is returned. Abort with `signal`.
 */
export async function streamChat({ baseUrl, apiKey = "", model, messages, temperature = 0.7, maxTokens = 1024, signal, fetchImpl = fetch, onDelta = () => {} }) {
  const response = await fetchImpl(apiUrl(baseUrl, "/v1/chat/completions"), {
    method: "POST",
    headers: requestHeaders(apiKey),
    body: JSON.stringify({ model, messages, stream: true, temperature, max_tokens: maxTokens }),
    signal,
  });
  if (!response.ok) throw new Error(await responseError(response));
  let text = "";
  for await (const delta of streamDeltas(response)) {
    text += delta;
    onDelta(delta, text);
  }
  return text;
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
