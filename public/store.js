import { titleFrom } from "./openai.js";

/**
 * Browser-local state. Conversations and preferences live in localStorage; the
 * API key lives in sessionStorage so closing the tab forgets it. Every function
 * takes the storage object, which makes the rules testable without a browser.
 */

export const SETTINGS_KEY = "chatduck.settings.v1";
export const CONVERSATIONS_KEY = "chatduck.conversations.v1"; // aikit:allow-secret storage key, not a credential
export const API_KEY = "chatduck.apiKey";
export const MAX_CONVERSATIONS = 200;

export const DEFAULT_SETTINGS = Object.freeze({
  baseUrl: "http://127.0.0.1:4141",
  model: "modelduck",
  systemPrompt: "",
  temperature: 0.7,
  maxTokens: 1024,
  theme: "dark",
});

const numberIn = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

const text = (value, fallback = "") => (typeof value === "string" ? value : fallback);

export function normalizeSettings(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    baseUrl: text(source.baseUrl, DEFAULT_SETTINGS.baseUrl).trim() || DEFAULT_SETTINGS.baseUrl,
    model: text(source.model, DEFAULT_SETTINGS.model).trim() || DEFAULT_SETTINGS.model,
    systemPrompt: text(source.systemPrompt, DEFAULT_SETTINGS.systemPrompt).slice(0, 4000),
    temperature: numberIn(source.temperature, 0, 2, DEFAULT_SETTINGS.temperature),
    maxTokens: numberIn(source.maxTokens, 16, 8192, DEFAULT_SETTINGS.maxTokens),
    theme: source.theme === "light" ? "light" : "dark",
  };
}

function parse(storage, key, fallback) {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function loadSettings(storage = globalThis.localStorage) {
  return normalizeSettings(parse(storage, SETTINGS_KEY, DEFAULT_SETTINGS));
}

export function saveSettings(storage, settings) {
  const value = normalizeSettings(settings);
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(value));
  } catch {
    // A full or disabled storage must not break the chat.
  }
  return value;
}

export function loadApiKey(session = globalThis.sessionStorage) {
  try {
    return session?.getItem(API_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveApiKey(session, key) {
  try {
    if (key) session?.setItem(API_KEY, String(key));
    else session?.removeItem(API_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function normalizeMessage(message) {
  if (!message || !["user", "assistant"].includes(message.role)) return null;
  return { role: message.role, content: text(message.content) };
}

function normalizeConversation(conversation) {
  if (!conversation || typeof conversation.id !== "string") return null;
  const timestamp = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : Date.now();
  };
  const messages = Array.isArray(conversation.messages) ? conversation.messages.map(normalizeMessage).filter(Boolean) : [];
  return {
    id: conversation.id,
    title: text(conversation.title, "New chat").slice(0, 120) || "New chat",
    createdAt: timestamp(conversation.createdAt),
    updatedAt: timestamp(conversation.updatedAt),
    messages,
  };
}

export function loadConversations(storage = globalThis.localStorage) {
  const list = parse(storage, CONVERSATIONS_KEY, []);
  if (!Array.isArray(list)) return [];
  return list
    .map(normalizeConversation)
    .filter(Boolean)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_CONVERSATIONS);
}

export function saveConversations(storage, conversations) {
  const list = (Array.isArray(conversations) ? conversations : [])
    .map(normalizeConversation)
    .filter(Boolean)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_CONVERSATIONS);
  try {
    storage?.setItem(CONVERSATIONS_KEY, JSON.stringify(list));
  } catch {
    // Ignore storage failures.
  }
  return list;
}

let sequence = 0;

export function newConversation({ now = Date.now(), id = null } = {}) {
  sequence += 1;
  const unique = id ?? globalThis.crypto?.randomUUID?.() ?? `${now}-${sequence}`;
  return { id: unique, title: "New chat", createdAt: now, updatedAt: now, messages: [] };
}

/** Add a message, title the chat from its first user line, and mark it updated. */
export function appendMessage(conversation, role, content, now = Date.now()) {
  conversation.messages.push({ role, content });
  if (role === "user" && conversation.title === "New chat") conversation.title = titleFrom(content);
  conversation.updatedAt = now;
  return conversation;
}
