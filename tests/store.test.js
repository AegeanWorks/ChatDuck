import assert from "node:assert/strict";
import test from "node:test";

import {
  API_KEY,
  appendMessage,
  loadApiKey,
  loadConversations,
  loadSettings,
  MAX_CONVERSATIONS,
  newConversation,
  normalizeSettings,
  removeTrailingAssistant,
  saveApiKey,
  saveConversations,
  saveSettings,
} from "../public/store.js";

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    map,
  };
}

test("settings are clamped and survive corrupt storage", () => {
  assert.deepEqual(normalizeSettings({ temperature: 9, maxTokens: -4, theme: "neon" }), {
    baseUrl: "http://127.0.0.1:4141",
    model: "modelduck",
    systemPrompt: "",
    temperature: 2,
    maxTokens: 16,
    theme: "dark",
  });
  const storage = fakeStorage();
  storage.setItem("chatduck.settings.v1", "{not json");
  assert.equal(loadSettings(storage).model, "modelduck");
  // hygiene: allow test example URL
  const saved = saveSettings(storage, { baseUrl: " http://x:1/ ", model: " qwen ", temperature: "0.2" });
  // hygiene: allow test example URL
  assert.equal(saved.baseUrl, "http://x:1/");
  assert.equal(loadSettings(storage).model, "qwen");
});

test("the API key lives in the session storage and can be removed", () => {
  const session = fakeStorage();
  saveApiKey(session, "secret");
  assert.equal(loadApiKey(session), "secret");
  saveApiKey(session, "");
  assert.equal(loadApiKey(session), "");
  assert.equal(session.map.has(API_KEY), false);
});

test("conversations survive a round trip, are capped and sorted", () => {
  const storage = fakeStorage();
  const list = Array.from({ length: MAX_CONVERSATIONS + 5 }, (_value, index) => ({
    id: `c-${index}`,
    title: `Chat ${index}`,
    createdAt: index,
    updatedAt: index,
    messages: [{ role: "user", content: `message ${index}` }],
  }));
  const saved = saveConversations(storage, list);
  assert.equal(saved.length, MAX_CONVERSATIONS);
  assert.equal(saved[0].id, `c-${MAX_CONVERSATIONS + 4}`, "newest first");
  assert.equal(loadConversations(storage).length, MAX_CONVERSATIONS);
});

test("an invalid stored conversation is dropped, not crashing the app", () => {
  const storage = fakeStorage();
  storage.setItem("chatduck.conversations.v1", JSON.stringify([
    null,
    { id: "ok", title: "Good", messages: [{ role: "user", content: "hi" }, { role: "system", content: "x" }] },
  ]));
  const list = loadConversations(storage);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].messages, [{ role: "user", content: "hi" }]);
});

test("regenerate removes exactly one trailing assistant turn", () => {
  const conversation = newConversation({ id: "regen", now: 10 });
  appendMessage(conversation, "user", "Why is the sky blue?", 20);
  appendMessage(conversation, "assistant", "Rayleigh scattering.", 30);
  appendMessage(conversation, "assistant", "A second trailing answer.", 35);
  assert.equal(removeTrailingAssistant(conversation, 40), true);
  assert.deepEqual(conversation.messages, [
    { role: "user", content: "Why is the sky blue?" },
    { role: "assistant", content: "Rayleigh scattering." },
  ]);
  assert.equal(conversation.updatedAt, 40);
  assert.equal(removeTrailingAssistant(conversation, 50), true);
  assert.deepEqual(conversation.messages, [{ role: "user", content: "Why is the sky blue?" }]);
  assert.equal(conversation.updatedAt, 50);
  assert.equal(removeTrailingAssistant(conversation, 60), false, "a user turn is not removed");
  assert.equal(conversation.updatedAt, 50);
});

test("a new conversation gets a title from its first user message", () => {
  const conversation = newConversation({ id: "one", now: 10 });
  appendMessage(conversation, "user", "Fix the parser in this file.", 20);
  assert.equal(conversation.title, "Fix the parser in this file.");
  assert.equal(conversation.updatedAt, 20);
  assert.equal(conversation.messages.length, 1);
});
