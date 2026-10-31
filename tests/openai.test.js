import assert from "node:assert/strict";
import test from "node:test";

import {
  apiUrl,
  buildMessages,
  listModels,
  normalizeBaseUrl,
  parseSseChunk,
  streamChat,
  titleFrom,
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
