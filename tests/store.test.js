import assert from "node:assert/strict";
import test from "node:test";

import {
  allConversationsToJSON,
  API_KEY,
  appendMessage,
  clearDraft,
  clearDrafts,
  contextUsage,
  conversationFromJSON,
  conversationsFromJSON,
  conversationToJSON,
  conversationToMarkdown,
  deleteMessageAt,
  DRAFTS_KEY,
  duplicateConversation,
  editUserMessage,
  estimateConversationTokens,
  getDraft,
  loadApiKey,
  loadConversations,
  loadSettings,
  MAX_CONVERSATIONS,
  MAX_DRAFT_CHARS,
  newConversation,
  normalizeSettings,
  removeTrailingAssistant,
  renameConversation,
  saveApiKey,
  saveConversations,
  saveSettings,
  setDraft,
  sortConversations,
  togglePin,
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
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    seed: "",
    maxTokens: 16,
    showThinking: true,
    autoTitle: false,
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
    { role: "user", content: "Why is the sky blue?", ts: 20 },
    { role: "assistant", content: "Rayleigh scattering.", ts: 30 },
  ]);
  assert.equal(conversation.updatedAt, 40);
  assert.equal(removeTrailingAssistant(conversation, 50), true);
  assert.deepEqual(conversation.messages, [{ role: "user", content: "Why is the sky blue?", ts: 20 }]);
  assert.equal(conversation.updatedAt, 50);
  assert.equal(removeTrailingAssistant(conversation, 60), false, "a user turn is not removed");
  assert.equal(conversation.updatedAt, 50);
});

test("edit, delete, rename, duplicate and export manage history", () => {
  const conversation = newConversation({ id: "hist", now: 10 });
  appendMessage(conversation, "user", "Hello world", 20);
  appendMessage(conversation, "assistant", "Hi there", 30);
  assert.equal(editUserMessage(conversation, 0, "Hello edited", 40), true);
  assert.deepEqual(conversation.messages, [{ role: "user", content: "Hello edited", ts: 40 }]);
  appendMessage(conversation, "assistant", "Reply two", 50);
  assert.equal(deleteMessageAt(conversation, 1, 60), true);
  assert.equal(conversation.messages.length, 1);
  renameConversation(conversation, "Renamed", 70);
  assert.equal(conversation.title, "Renamed");
  const copy = duplicateConversation(conversation, { now: 80, id: "copy-1" });
  assert.equal(copy.id, "copy-1");
  assert.ok(copy.title.includes("(copy)"));
  assert.ok(conversationToMarkdown(conversation).includes("Renamed"));
  assert.ok(estimateConversationTokens(conversation) >= 1);
  assert.equal(editUserMessage(conversation, 5, "nope"), false);
  assert.equal(deleteMessageAt(conversation, 5), false);
  assert.equal(renameConversation(null, "x"), false);
});

test("images attach to user turns and survive a JSON round trip", () => {
  const conversation = newConversation({ id: "vision", now: 10 });
  appendMessage(conversation, "user", "look", 20, ["data:image/jpeg;base64,AAA", "nope"]);
  assert.equal(conversation.messages[0].images.length, 1);
  const json = conversationToJSON(conversation);
  const back = conversationFromJSON(json);
  assert.equal(back.messages[0].images[0], "data:image/jpeg;base64,AAA");
  assert.throws(() => conversationFromJSON("{bad"), /./);
  assert.throws(() => conversationFromJSON(JSON.stringify({ nope: true })), /not a ChatDuck/);
});

test("editing keeps attached images for the resend", () => {
  const conversation = newConversation({ id: "img-edit", now: 10 });
  appendMessage(conversation, "user", "look", 20, ["data:image/png;base64,AAA"]);
  assert.equal(editUserMessage(conversation, 0, "look closer", 30), true);
  assert.deepEqual(conversation.messages[0].images, ["data:image/png;base64,AAA"]);
  assert.equal(conversation.messages[0].content, "look closer");
});

test("a quota failure still saves the text without images", () => {
  const backing = fakeStorage();
  let calls = 0;
  const tight = {
    getItem: (key) => backing.getItem(key),
    setItem: (key, value) => {
      calls += 1;
      if (String(value).length > 200) throw new Error("QuotaExceededError");
      backing.setItem(key, value);
    },
    removeItem: (key) => backing.removeItem(key),
  };
  const conversation = newConversation({ id: "quota", now: 10 });
  appendMessage(conversation, "user", "look", 20, [`data:image/png;base64,${"A".repeat(300)}`]);
  const saved = saveConversations(tight, [conversation]);
  assert.equal(calls, 2, "retries text-only after the quota error");
  assert.ok(saved[0].messages[0].images?.length, "the live copy keeps its images");
  const loaded = loadConversations(tight);
  assert.equal(loaded[0].messages[0].content, "look");
  assert.equal(loaded[0].messages[0].images, undefined);
});

test("timestamps, context meter and backup round trips work", () => {
  const conversation = newConversation({ id: "ctx", now: 100 });
  appendMessage(conversation, "user", "hello there", 200);
  assert.equal(conversation.messages[0].ts, 200);
  const ctx = contextUsage(conversation, 100);
  assert.ok(ctx.used >= 1 && ctx.budget === 100 && ctx.percent >= 0);
  const backup = allConversationsToJSON([conversation]);
  const restored = conversationsFromJSON(backup);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].messages[0].ts, 200);
  assert.throws(() => conversationsFromJSON('"garbage"'), /not a ChatDuck/);
});

test("pins sort first, seeds clamp and usage survives", () => {
  assert.equal(normalizeSettings({ seed: "7" }).seed, 7);
  assert.equal(normalizeSettings({ seed: "nope" }).seed, "");
  const older = newConversation({ id: "older", now: 10 });
  const newer = newConversation({ id: "newer", now: 20 });
  togglePin(older, 30);
  assert.equal(older.pinned, true);
  assert.deepEqual(sortConversations([newer, older]).map((conversation) => conversation.id), ["older", "newer"]);
  const storage = fakeStorage();
  saveConversations(storage, [newer, older]);
  assert.equal(loadConversations(storage)[0].id, "older");
  const withUsage = { id: "u", title: "U", createdAt: 1, updatedAt: 2, messages: [{ role: "assistant", content: "hi", usage: { prompt: 3, completion: 4, total: 7 } }] };
  storage.setItem("chatduck.conversations.v1", JSON.stringify([withUsage]));
  assert.deepEqual(loadConversations(storage)[0].messages[0].usage, { prompt: 3, completion: 4, total: 7 });
});

test("theme accepts auto and falls back to dark otherwise", () => {
  assert.equal(normalizeSettings({ theme: "auto" }).theme, "auto");
  assert.equal(normalizeSettings({ theme: "light" }).theme, "light");
  assert.equal(normalizeSettings({ theme: "neon" }).theme, "dark");
});

test("auto-title is opt-in and off by default", () => {
  assert.equal(normalizeSettings({}).autoTitle, false);
  assert.equal(normalizeSettings({ autoTitle: true }).autoTitle, true);
  assert.equal(normalizeSettings({ autoTitle: "yes" }).autoTitle, false);
});

test("a new conversation gets a title from its first user message", () => {
  const conversation = newConversation({ id: "one", now: 10 });
  appendMessage(conversation, "user", "Fix the parser in this file.", 20);
  assert.equal(conversation.title, "Fix the parser in this file.");
  assert.equal(conversation.updatedAt, 20);
  assert.equal(conversation.messages.length, 1);
});

test("composer drafts persist per chat and clear on send", () => {
  const storage = fakeStorage();
  assert.equal(getDraft(storage, "a"), "");
  setDraft(storage, "a", "half-written thought");
  setDraft(storage, "b", "other chat draft");
  assert.equal(getDraft(storage, "a"), "half-written thought");
  assert.equal(getDraft(storage, "b"), "other chat draft");
  clearDraft(storage, "a");
  assert.equal(getDraft(storage, "a"), "");
  assert.equal(getDraft(storage, "b"), "other chat draft");
  clearDrafts(storage);
  assert.equal(getDraft(storage, "b"), "");
  assert.equal(storage.getItem(DRAFTS_KEY), null);
});

test("whitespace-only drafts clear the entry and ids are required", () => {
  const storage = fakeStorage();
  setDraft(storage, "a", "something");
  assert.equal(setDraft(storage, "a", "   \n  "), "");
  assert.equal(storage.getItem(DRAFTS_KEY), JSON.stringify({}));
  assert.equal(setDraft(storage, "", "kept?"), "");
  assert.equal(getDraft(storage, null), "");
  assert.equal(getDraft(storage, "missing"), "");
  clearDraft(storage, "missing");
  clearDraft(storage, null);
});

test("drafts are capped and survive corrupt or full storage", () => {
  const storage = fakeStorage();
  const long = `x${"y".repeat(MAX_DRAFT_CHARS + 100)}`;
  assert.equal(setDraft(storage, "a", long).length, MAX_DRAFT_CHARS);
  assert.equal(getDraft(storage, "a").length, MAX_DRAFT_CHARS);
  storage.setItem(DRAFTS_KEY, "{not json");
  assert.equal(getDraft(storage, "a"), "");
  storage.setItem(DRAFTS_KEY, JSON.stringify(["not", "a", "map"]));
  assert.equal(getDraft(storage, "a"), "");
  const backing = fakeStorage();
  const full = {
    getItem: (key) => backing.getItem(key),
    setItem: () => { throw new Error("QuotaExceededError"); },
    removeItem: (key) => backing.removeItem(key),
  };
  assert.equal(setDraft(full, "a", "live value stays"), "live value stays");
  assert.equal(getDraft(full, "a"), "");
});

test("duplicate rejects a missing conversation instead of throwing", () => {
  assert.equal(duplicateConversation(null), false);
  assert.equal(duplicateConversation(undefined), false);
});

test("duplicate deep-isolates usage and images", () => {
  const conversation = newConversation({ id: "a", now: 1 });
  appendMessage(conversation, "user", "hi", 2, ["data:image/png;base64,AAA"]);
  conversation.messages[0].usage = { prompt: 1, completion: 1, total: 2 };
  const copy = duplicateConversation(conversation, { now: 3, id: "b" });
  copy.messages[0].usage.prompt = 999;
  copy.messages[0].images.push("data:image/png;base64,BBB");
  assert.equal(conversation.messages[0].usage.prompt, 1);
  assert.equal(conversation.messages[0].images.length, 1);
});

test("delete and edit reject null or empty indexes", () => {
  const conversation = newConversation({ id: "x", now: 1 });
  appendMessage(conversation, "user", "a", 2);
  assert.equal(deleteMessageAt(conversation, null, 3), false);
  assert.equal(deleteMessageAt(conversation, "", 3), false);
  assert.equal(conversation.messages.length, 1);
  assert.equal(editUserMessage(conversation, "", "hacked", 3), false);
  assert.equal(conversation.messages[0].content, "a");
});

test("an empty id generates a fresh id", () => {
  assert.notEqual(newConversation({ id: "", now: 1 }).id, "");
});

test("rename reports success as a boolean", () => {
  const conversation = newConversation({ id: "r", now: 1 });
  assert.strictEqual(renameConversation(conversation, "Hi", 2), true);
});

test("single-chat JSON fails fast on invalid input", () => {
  assert.throws(() => conversationToJSON(null), /not a ChatDuck conversation/);
  assert.throws(() => conversationToJSON({ nope: true }), /not a ChatDuck conversation/);
});

test("an empty backup round-trips to an empty library", () => {
  assert.deepEqual(conversationsFromJSON(allConversationsToJSON([])), []);
  assert.deepEqual(conversationsFromJSON("[]"), []);
});

test("the token estimate ignores missing fields", () => {
  assert.equal(
    estimateConversationTokens({ messages: [{ role: "user" }] }),
    estimateConversationTokens({ messages: [{ role: "user", content: "" }] }),
  );
});

test("empty-string usage stays null instead of becoming 0", () => {
  const storage = fakeStorage();
  storage.setItem("chatduck.conversations.v1", JSON.stringify([
    { id: "u2", title: "U", createdAt: 1, updatedAt: 2, messages: [{ role: "assistant", content: "hi", usage: { prompt: "", completion: "", total: "" } }] },
  ]));
  assert.equal(loadConversations(storage)[0].messages[0].usage, undefined);
});

test("an empty object backup round-trips to an empty library", () => {
  assert.deepEqual(conversationsFromJSON(JSON.stringify({ conversations: [] })), []);
  assert.deepEqual(conversationsFromJSON({ conversations: [] }), []);
});

test("overlong drafts are capped on read", () => {
  const storage = fakeStorage();
  storage.setItem(DRAFTS_KEY, JSON.stringify({ a: "x".repeat(MAX_DRAFT_CHARS + 50) }));
  assert.equal(getDraft(storage, "a").length, MAX_DRAFT_CHARS);
});
