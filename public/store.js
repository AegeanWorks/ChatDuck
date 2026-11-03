import { titleFrom } from "./openai.js";

/**
 * Browser-local state. Conversations and preferences live in localStorage; the
 * API key lives in sessionStorage so closing the tab forgets it. Every function
 * takes the storage object, which makes the rules testable without a browser.
 */

export const SETTINGS_KEY = "chatduck.settings.v1";
export const CONVERSATIONS_KEY = "chatduck.conversations.v1"; // aikit:allow-secret storage key, not a credential
export const API_KEY = "chatduck.apiKey";
export const DRAFTS_KEY = "chatduck.drafts.v1"; // aikit:allow-secret storage key, not a credential
export const MAX_CONVERSATIONS = 200;
/** Long pastes stay restorable without crowding out chats in localStorage. */
export const MAX_DRAFT_CHARS = 20000;

export const DEFAULT_SETTINGS = Object.freeze({
  baseUrl: "http://127.0.0.1:4141",
  model: "modelduck",
  systemPrompt: "",
  temperature: 0.7,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  seed: "",
  maxTokens: 1024,
  showThinking: true,
  autoTitle: false,
  theme: "dark",
});

const numberIn = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

const text = (value, fallback = "") => (typeof value === "string" ? value : fallback);

const normalizeSeed = (value) => {
  if (value === null || value === undefined || value === "") return "";
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 && number <= 4294967295 ? number : "";
};

export function normalizeSettings(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    baseUrl: text(source.baseUrl, DEFAULT_SETTINGS.baseUrl).trim() || DEFAULT_SETTINGS.baseUrl,
    model: text(source.model, DEFAULT_SETTINGS.model).trim() || DEFAULT_SETTINGS.model,
    systemPrompt: text(source.systemPrompt, DEFAULT_SETTINGS.systemPrompt).slice(0, 4000),
    temperature: numberIn(source.temperature, 0, 2, DEFAULT_SETTINGS.temperature),
    topP: numberIn(source.topP ?? source.top_p ?? 1, 0, 1, DEFAULT_SETTINGS.topP),
    frequencyPenalty: numberIn(source.frequencyPenalty ?? source.frequency_penalty ?? 0, -2, 2, DEFAULT_SETTINGS.frequencyPenalty),
    presencePenalty: numberIn(source.presencePenalty ?? source.presence_penalty ?? 0, -2, 2, DEFAULT_SETTINGS.presencePenalty),
    seed: normalizeSeed(source.seed),
    maxTokens: numberIn(source.maxTokens, 16, 8192, DEFAULT_SETTINGS.maxTokens),
    showThinking: source.showThinking === undefined ? true : source.showThinking !== false && source.showThinking !== "false",
    autoTitle: source.autoTitle === true,
    theme: ["light", "dark", "auto"].includes(source.theme) ? source.theme : "dark",
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

function loadDrafts(storage) {
  const parsed = parse(storage, DRAFTS_KEY, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out = {};
  for (const [id, draft] of Object.entries(parsed)) {
    if (typeof id === "string" && typeof draft === "string") out[id] = draft;
  }
  return out;
}

/** Unsent composer text for one chat; corrupt storage reads as empty. */
export function getDraft(storage, id) {
  if (typeof id !== "string" || !id) return "";
  try {
    const draft = loadDrafts(storage)[id];
    return typeof draft === "string" ? draft : "";
  } catch {
    return "";
  }
}

/**
 * Persist unsent composer text for one chat. Whitespace-only input clears
 * the entry; overlong drafts are sliced. A full store never breaks typing:
 * the composer keeps its live value either way.
 */
export function setDraft(storage, id, draft) {
  if (typeof id !== "string" || !id) return "";
  const next = String(draft ?? "");
  try {
    const all = loadDrafts(storage);
    if (!next.trim()) {
      if (id in all) {
        delete all[id];
        storage?.setItem(DRAFTS_KEY, JSON.stringify(all));
      }
      return "";
    }
    all[id] = next.slice(0, MAX_DRAFT_CHARS);
    storage?.setItem(DRAFTS_KEY, JSON.stringify(all));
    return all[id];
  } catch {
    return next.slice(0, MAX_DRAFT_CHARS);
  }
}

/** Forget one chat's unsent composer text. */
export function clearDraft(storage, id) {
  if (typeof id !== "string" || !id) return;
  try {
    const all = loadDrafts(storage);
    if (id in all) {
      delete all[id];
      storage?.setItem(DRAFTS_KEY, JSON.stringify(all));
    }
  } catch {
    // Ignore storage failures.
  }
}

/** Forget every unsent composer draft. */
export function clearDrafts(storage) {
  try {
    storage?.removeItem(DRAFTS_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export const MAX_IMAGES_PER_MESSAGE = 4;

function normalizeMessage(message) {
  if (!message || !["user", "assistant"].includes(message.role)) return null;
  const content = Array.isArray(message.content)
    ? message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
    : text(message.content);
  const out = { role: message.role, content };
  const reasoning = text(message.reasoning);
  if (reasoning) out.reasoning = reasoning.slice(0, 20000);
  if (Number.isFinite(Number(message.elapsedMs))) out.elapsedMs = Number(message.elapsedMs);
  if (Number.isFinite(Number(message.tokensPerSecond))) out.tokensPerSecond = Number(message.tokensPerSecond);
  if (Number.isFinite(Number(message.ts))) out.ts = Number(message.ts);
  const usage = message.usage;
  if (usage && typeof usage === "object") {
    const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
    const clean = { prompt: number(usage.prompt), completion: number(usage.completion), total: number(usage.total) };
    if (clean.prompt !== null || clean.completion !== null || clean.total !== null) out.usage = clean;
  }
  if (message.role === "user" && Array.isArray(message.images)) {
    const images = message.images.filter((image) => typeof image === "string" && image.startsWith("data:image/")).slice(0, MAX_IMAGES_PER_MESSAGE);
    if (images.length) out.images = images;
  }
  return out;
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
    pinned: conversation.pinned === true,
    messages,
  };
}

/** Pinned chats first, then most recently updated. */
export function sortConversations(list) {
  return [...list].sort((left, right) => {
    if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
    return right.updatedAt - left.updatedAt;
  });
}

export function loadConversations(storage = globalThis.localStorage) {
  const list = parse(storage, CONVERSATIONS_KEY, []);
  if (!Array.isArray(list)) return [];
  return sortConversations(list.map(normalizeConversation).filter(Boolean)).slice(0, MAX_CONVERSATIONS);
}

export function saveConversations(storage, conversations) {
  const list = sortConversations(
    (Array.isArray(conversations) ? conversations : []).map(normalizeConversation).filter(Boolean),
  ).slice(0, MAX_CONVERSATIONS);
  try {
    storage?.setItem(CONVERSATIONS_KEY, JSON.stringify(list));
  } catch {
    // localStorage quotas (~5MB) are easy to hit with image data-URLs: retry
    // text-only so the conversation history itself is never lost.
    try {
      const slim = list.map((conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) => {
          if (!message.images) return message;
          const { images: _dropped, ...rest } = message;
          return rest;
        }),
      }));
      storage?.setItem(CONVERSATIONS_KEY, JSON.stringify(slim));
    } catch {
      // Ignore storage failures.
    }
  }
  return list;
}

let sequence = 0;

export function newConversation({ now = Date.now(), id = null } = {}) {
  sequence += 1;
  const unique = id || globalThis.crypto?.randomUUID?.() || `${now}-${sequence}`;
  return { id: unique, title: "New chat", createdAt: now, updatedAt: now, messages: [] };
}

/** Remove one trailing assistant turn so regeneration can replay the last user turn. */
export function removeTrailingAssistant(conversation, now = Date.now()) {
  if (!conversation || !Array.isArray(conversation.messages)) return false;
  if (conversation.messages.at(-1)?.role !== "assistant") return false;
  conversation.messages.pop();
  conversation.updatedAt = now;
  return true;
}

/** Add a message, title the chat from its first user line, and mark it updated. */
export function appendMessage(conversation, role, content, now = Date.now(), images = []) {
  const message = { role, content, ts: now };
  const clean = Array.isArray(images)
    ? images.filter((image) => typeof image === "string" && image.startsWith("data:image/")).slice(0, MAX_IMAGES_PER_MESSAGE)
    : [];
  if (role === "user" && clean.length) message.images = clean;
  conversation.messages.push(message);
  if (role === "user" && conversation.title === "New chat") conversation.title = titleFrom(content);
  conversation.updatedAt = now;
  return conversation;
}

/** Pin or unpin a conversation; pinned chats sort first. */
export function togglePin(conversation, now = Date.now()) {
  if (!conversation) return false;
  conversation.pinned = !conversation.pinned;
  conversation.updatedAt = now;
  return conversation.pinned;
}

/** Rename a conversation (inline pencil in the header). */
export function renameConversation(conversation, title, now = Date.now()) {
  if (!conversation) return false;
  const next = String(title ?? "").trim().slice(0, 120);
  conversation.title = next || "New chat";
  conversation.updatedAt = now;
  return true;
}

/** Duplicate a conversation so a branch can be explored safely. */
export function duplicateConversation(conversation, { now = Date.now(), id = null } = {}) {
  if (!conversation) return false;
  const unique = id || globalThis.crypto?.randomUUID?.() || `${now}-${Math.floor(Math.random() * 1e9)}`;
  return {
    id: unique,
    title: `${conversation.title} (copy)`.slice(0, 120),
    createdAt: now,
    updatedAt: now,
    messages: (conversation.messages ?? []).map((message) => ({
      ...message,
      ...(Array.isArray(message?.images) ? { images: [...message.images] } : {}),
      ...(message?.usage && typeof message.usage === "object" ? { usage: { ...message.usage } } : {}),
    })),
  };
}

/** A message index is valid only when it addresses an existing turn. */
function toMessageIndex(index, length) {
  if (typeof index !== "number" && typeof index !== "string") return -1;
  if (typeof index === "string" && index.trim() === "") return -1;
  const at = Number(index);
  if (!Number.isInteger(at) || at < 0 || at >= length) return -1;
  return at;
}

/** Remove one message; used for per-message delete buttons. */
export function deleteMessageAt(conversation, index, now = Date.now()) {
  if (!conversation || !Array.isArray(conversation.messages)) return false;
  const at = toMessageIndex(index, conversation.messages.length);
  if (at < 0) return false;
  conversation.messages.splice(at, 1);
  conversation.updatedAt = now;
  return true;
}

/**
 * Replace a user turn and drop everything after it, so "edit & resend"
 * replays from that point like modern chat UIs.
 */
export function editUserMessage(conversation, index, content, now = Date.now()) {
  const next = String(content ?? "").trim();
  if (!conversation || !Array.isArray(conversation.messages)) return false;
  const at = toMessageIndex(index, conversation.messages.length);
  if (at < 0) return false;
  if (conversation.messages[at]?.role !== "user" || !next) return false;
  const edited = { role: "user", content: next, ts: now };
  // Keep vision attachments: the text is re-sent with the same images.
  if (Array.isArray(conversation.messages[at].images)) edited.images = conversation.messages[at].images;
  conversation.messages[at] = edited;
  conversation.messages.splice(at + 1);
  conversation.updatedAt = now;
  if (at === 0) conversation.title = titleFrom(next);
  return true;
}

/** Export a conversation as Markdown for copy/download. */
export function conversationToMarkdown(conversation) {
  const lines = [`# ${conversation?.title || "Chat"}`, ""];
  for (const message of conversation?.messages ?? []) {
    lines.push(message.role === "user" ? "## You" : "## ChatDuck");
    if (message.role === "user" && message.images?.length) lines.push(`_(${message.images.length} image${message.images.length === 1 ? "" : "s"} attached)_`);
    if (message.reasoning) lines.push("", "> Thinking: " + String(message.reasoning).split("\n").join("\n> "));
    lines.push("", message.content || "_(empty)_", "");
  }
  return lines.join("\n").trim() + "\n";
}

/** Serialize one conversation for JSON download (images included). */
export function conversationToJSON(conversation) {
  return JSON.stringify(normalizeConversation(conversation), null, 2);
}

/** Parse an imported JSON chat; returns the conversation or throws. */
export function conversationFromJSON(raw) {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const candidate = Array.isArray(parsed) ? parsed[0] : (parsed?.conversations?.[0] ?? parsed);
  const normalized = normalizeConversation(candidate);
  if (!normalized) throw new Error("That file is not a ChatDuck chat.");
  return normalized;
}

/** Parse an imported backup: one chat or an array of chats. */
export function conversationsFromJSON(raw) {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const candidates = Array.isArray(parsed) ? parsed : [parsed?.conversations ?? parsed];
  const list = candidates.flat().map(normalizeConversation).filter(Boolean);
  if (!list.length) throw new Error("That file is not a ChatDuck chat.");
  return list.slice(0, MAX_CONVERSATIONS);
}

/** Serialize every conversation for a full backup download. */
export function allConversationsToJSON(conversations) {
  const list = (Array.isArray(conversations) ? conversations : [])
    .map(normalizeConversation)
    .filter(Boolean);
  return JSON.stringify(list, null, 2);
}

/** Context-meter math: estimated tokens against the reply budget. */
export function contextUsage(conversation, maxTokens) {
  const used = estimateConversationTokens(conversation);
  const budget = Number(maxTokens) > 0 ? Number(maxTokens) : 0;
  const percent = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  return { used, budget, percent };
}

/** Rough token estimate for stats and the composer counter. */
export function estimateConversationTokens(conversation) {
  const text = (conversation?.messages ?? []).map((message) => `${message.role} ${message.content} ${message.reasoning ?? ""}`).join("\n");
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
