import assert from "node:assert/strict";
import test from "node:test";

import {
  apiUrl,
  attachmentExtension,
  buildMessages,
  contentParts,
  estimateTokens,
  isTextFile,
  listModels,
  MAX_TEXT_ATTACH_CHARS,
  normalizeBaseUrl,
  normalizeImages,
  normalizeUsage,
  parseSseChunk,
  reasoningOf,
  splitThinking,
  streamChat,
  suggestTitle,
  titleFrom,
  wrapTextAttachment,
} from "../public/openai.js";

const encoder = new TextEncoder();

function streamResponse(chunks, headers = { "content-type": "text/event-stream" }) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers });
}

test("a server URL is normalized without a trailing slash or /v1", () => {
  assert.equal(normalizeBaseUrl("http://127.0.0.1:4141/"), "http://127.0.0.1:4141");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:4141/v1"), "http://127.0.0.1:4141");
  // hygiene: allow test example URL
  assert.equal(normalizeBaseUrl("https://example.test/api/v1/"), "https://example.test/api");
  assert.equal(apiUrl("http://127.0.0.1:4141/v1", "/v1/models"), "http://127.0.0.1:4141/v1/models");
  assert.throws(() => normalizeBaseUrl("ftp://example.test"), /http/);
  assert.throws(() => normalizeBaseUrl(""), /server URL/);
});

test("messages put the system prompt first and skip empty turns", () => {
  assert.deepEqual(buildMessages({
    systemPrompt: "Be precise.",
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "assistant", content: "" },
      { role: "system", content: "ignored" },
    ],
  }), [
    { role: "system", content: "Be precise." },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello" },
  ]);
});

test("SSE parsing keeps an unfinished event for the next chunk", () => {
  const first = parseSseChunk('data: {"a":1}\n\ndata: {"b"');
  assert.deepEqual(first.events, ['{"a":1}']);
  const second = parseSseChunk(`${first.rest}:2}\n\n`);
  assert.deepEqual(second.events, ['{"b":2}']);
  assert.equal(second.rest, "");
});

test("SSE events may use CRLF line endings", () => {
  assert.deepEqual(parseSseChunk('data: {"a":1}\r\n\r\n').events, ['{"a":1}']);
});

test("an error event in the stream is raised", async () => {
  await assert.rejects(
    streamChat({
      baseUrl: "http://127.0.0.1:4141",
      model: "modelduck",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: async () => streamResponse(['data: {"error":{"message":"boom","why":"bad"}}\n\n']),
    }),
    /boom — bad/,
  );
});

test("a streamed answer arrives in deltas and as the full text", async () => {
  const deltas = [];
  const text = await streamChat({
    baseUrl: "http://127.0.0.1:4141",
    model: "modelduck",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: async () => streamResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
    onDelta: (delta) => deltas.push(delta),
  });
  assert.equal(text, "Hello");
  assert.deepEqual(deltas, ["Hel", "lo"]);
});

test("an error response keeps the server's explanation", async () => {
  await assert.rejects(
    streamChat({
      baseUrl: "http://127.0.0.1:4141",
      model: "modelduck",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "Invalid key", why: "The key was not accepted." } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    }),
    /Invalid key — The key was not accepted/,
  );
});

test("stream:false sends a non-streaming request and reads the JSON answer", async () => {
  let body;
  const text = await streamChat({
    baseUrl: "http://127.0.0.1:4141",
    model: "modelduck",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "Flat" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(body.stream, false);
  assert.equal(text, "Flat");
});

test("suggestTitle strips quotes and falls back to a default", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: '"Fix the flaky parser"' } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  assert.equal(await suggestTitle({ baseUrl: "http://127.0.0.1:4141", model: "m", userText: "Fix the flaky parser", fetchImpl }), "Fix the flaky parser");
  const empty = async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  assert.equal(await suggestTitle({ baseUrl: "http://127.0.0.1:4141", model: "m", userText: "hi", fetchImpl: empty }), "New chat");
});

test("a non-streaming JSON answer is still read", async () => {
  const text = await streamChat({
    baseUrl: "http://127.0.0.1:4141",
    model: "modelduck",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "Quack" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(text, "Quack");
});

test("reasoning deltas and think tags are separated from the answer", async () => {
  assert.equal(reasoningOf({ delta: { reasoning_content: "plan" } }), "plan");
  assert.deepEqual(splitThinking("<think>draft</think>\nDone"), { thinking: "draft", visible: "Done" });
  assert.ok(estimateTokens("abcd") >= 1);
  let seen = "";
  const text = await streamChat({
    baseUrl: "http://127.0.0.1:4141",
    model: "modelduck",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: async () => streamResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"pla"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"n"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
    onReasoning: (_delta, full) => { seen = full; },
  });
  assert.equal(text, "Hi");
  assert.equal(seen, "plan");
});

test("vision turns use content parts; text-only turns stay strings", () => {
  assert.equal(contentParts("hello", []), "hello");
  const parts = contentParts("look", ["data:image/jpeg;base64,AAA", "not-an-image"]);
  assert.equal(parts[0].type, "text");
  assert.equal(parts[1].type, "image_url");
  assert.equal(parts.length, 2, "non-images are dropped");
  assert.deepEqual(normalizeImages(["data:image/png;base64,AAA", "x"]).length, 1);
  const messages = buildMessages({
    messages: [{ role: "user", content: "look", images: ["data:image/jpeg;base64,AAA"] }],
  });
  assert.equal(messages[0].content[1].image_url.url, "data:image/jpeg;base64,AAA");
  const plain = buildMessages({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(plain[0].content, "hi");
});

test("sampling penalties are sent only when non-zero", async () => {
  const bodies = [];
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return streamResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"]);
  };
  await streamChat({ baseUrl: "http://127.0.0.1:4141", model: "m", messages: [], fetchImpl });
  assert.ok(!("frequency_penalty" in bodies[0]), "zero penalties are omitted for strict servers");
  await streamChat({ baseUrl: "http://127.0.0.1:4141", model: "m", messages: [], frequencyPenalty: 0.5, presencePenalty: -0.3, fetchImpl });
  assert.equal(bodies[1].frequency_penalty, 0.5);
  assert.equal(bodies[1].presence_penalty, -0.3);
});

test("seed is sent when set and server usage reaches the caller", async () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5 }), { prompt: 10, completion: 5, total: 15 });
  assert.equal(normalizeUsage({}), null);
  const bodies = [];
  let seen = null;
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return streamResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: {"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n', "data: [DONE]\n\n"]);
  };
  await streamChat({ baseUrl: "http://127.0.0.1:4141", model: "m", messages: [], fetchImpl, onUsage: (usage) => { seen = usage; } });
  assert.ok(!("seed" in bodies[0]), "empty seed is omitted for strict servers");
  await streamChat({ baseUrl: "http://127.0.0.1:4141", model: "m", messages: [], seed: 42, fetchImpl });
  assert.equal(bodies[1].seed, 42);
  assert.deepEqual(seen, { prompt: 3, completion: 4, total: 7 });
});

test("text files are detected and wrapped as truncated fenced blocks", () => {
  assert.equal(attachmentExtension("src/App.py"), "py");
  assert.equal(attachmentExtension("noext"), "");
  assert.equal(attachmentExtension(".hidden"), "");
  assert.equal(isTextFile({ name: "a.py", type: "" }), true);
  assert.equal(isTextFile({ name: "notes.md", type: "text/markdown" }), true);
  assert.equal(isTextFile({ name: "data.json", type: "application/json" }), true);
  assert.equal(isTextFile({ name: "a.png", type: "image/png" }), false);
  assert.equal(isTextFile({ name: "a.zip", type: "application/zip" }), false);
  assert.equal(isTextFile(null), false);
  const wrapped = wrapTextAttachment("app.py", "print(1)");
  assert.ok(wrapped.includes("**Attached file: app.py**"));
  assert.ok(wrapped.includes("```py"));
  const long = wrapTextAttachment("big.log", "x".repeat(MAX_TEXT_ATTACH_CHARS + 10));
  assert.ok(long.includes("truncated 10 more chars"));
});

test("raw-text SSE streams through and truncated JSON never leaks framing", async () => {
  const raw = await streamChat({
    baseUrl: "http://127.0.0.1:4141",
    model: "modelduck",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: async () => streamResponse(["data: Hello\n\n", "data: world\n\n"]),
  });
  assert.ok(raw.includes("Hello") && raw.includes("world"));
  assert.ok(!raw.includes("data:"), "no protocol syntax in the answer");
  const truncated = await streamChat({
    baseUrl: "http://127.0.0.1:4141",
    model: "modelduck",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: async () => streamResponse(['data: {"choices":[{"delta":{"content":"Hel']),
  });
  assert.equal(truncated, "");
  const noDone = await streamChat({
    baseUrl: "http://127.0.0.1:4141",
    model: "modelduck",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: async () => streamResponse(['data: {"choices":[{"delta":{"content":"Late"}}]}\n\n']),
  });
  assert.equal(noDone, "Late");
});

test("the model list and conversation titles are read from the API", async () => {
  const models = await listModels({
    baseUrl: "http://127.0.0.1:4141",
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "modelduck" }, { id: "qwen" }] }), { status: 200 }),
  });
  assert.deepEqual(models, ["modelduck", "qwen"]);
  assert.equal(titleFrom("Fix this bug\nmore detail"), "Fix this bug");
  assert.equal(titleFrom(""), "New chat");
  assert.equal(titleFrom("x".repeat(60)).length, 48);
});

test("UI-only assistant markers never reach the server", () => {
  // Error placeholders stay retryable locally but are dropped from history.
  assert.deepEqual(buildMessages({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "⚠ The request failed. — fix Settings or press Retry." },
      { role: "user", content: "are you there?" },
    ],
  }), [
    { role: "user", content: "hi" },
    { role: "user", content: "are you there?" },
  ]);
  // Stopped partials keep their visible text without the marker.
  assert.deepEqual(buildMessages({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "Partial answer\n\n_(stopped)_" },
    ],
  }), [
    { role: "user", content: "hi" },
    { role: "assistant", content: "Partial answer" },
  ]);
  // Abort before the first delta leaves nothing to send.
  assert.deepEqual(buildMessages({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "_(stopped)_" },
    ],
  }), [{ role: "user", content: "hi" }]);
  // Empty-answer placeholders never reach the server.
  assert.deepEqual(buildMessages({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "_(the server returned an empty answer)_" },
      { role: "user", content: "try again" },
    ],
  }), [
    { role: "user", content: "hi" },
    { role: "user", content: "try again" },
  ]);
  assert.deepEqual(buildMessages({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "_(the server returned reasoning without a final answer)_" },
    ],
  }), [{ role: "user", content: "hi" }]);
  // Stored think blocks send visible text only.
  assert.deepEqual(buildMessages({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "<think>draft plan</think>\nDone" },
    ],
  }), [
    { role: "user", content: "hi" },
    { role: "assistant", content: "Done" },
  ]);
});
