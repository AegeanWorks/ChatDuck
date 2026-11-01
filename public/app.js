import { buildMessages, listModels, normalizeBaseUrl, streamChat } from "./openai.js";
import { renderMarkdown } from "./markdown.js";
import { canRegenerate, isNearBottom } from "./chat.js";
import {
  appendMessage,
  loadApiKey,
  loadConversations,
  loadSettings,
  newConversation,
  normalizeSettings,
  removeTrailingAssistant,
  saveApiKey,
  saveConversations,
  saveSettings,
} from "./store.js";

const $ = (id) => document.getElementById(id);
const browserStorage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();
const browserSession = (() => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
})();

const el = {
  scrim: $("scrim"),
  sidebar: $("sidebar"),
  menu: $("menu-btn"),
  newChat: $("new-chat"),
  search: $("search"),
  chatList: $("chat-list"),
  settingsBtn: $("settings-btn"),
  themeBtn: $("theme-btn"),
  status: $("status"),
  serverLabel: $("server-label"),
  chatTitle: $("chat-title"),
  modelBadge: $("model-badge"),
  messages: $("messages"),
  jump: $("jump-latest"),
  composer: $("composer"),
  prompt: $("prompt"),
  stop: $("stop"),
  send: $("send"),
  dialog: $("settings-dialog"),
  settingsForm: $("settings-form"),
  settingUrl: $("setting-url"),
  settingKey: $("setting-key"),
  settingModel: $("setting-model"),
  modelOptions: $("model-options"),
  settingSystem: $("setting-system"),
  settingTemperature: $("setting-temperature"),
  settingMax: $("setting-max"),
  settingsStatus: $("settings-status"),
  testConnection: $("test-connection"),
  settingsClose: $("settings-close"),
};

const state = {
  settings: loadSettings(browserStorage),
  conversations: loadConversations(browserStorage),
  activeId: null,
  apiKey: loadApiKey(browserSession),
  models: [],
  streaming: null,
  search: "",
  frame: 0,
  stickToBottom: true,
};

const active = () => state.conversations.find((conversation) => conversation.id === state.activeId) ?? null;

function persist() {
  // Save a normalized copy, but keep the live objects: a streamed answer holds
  // a reference to the assistant message while deltas arrive.
  state.conversations.sort((left, right) => right.updatedAt - left.updatedAt);
  saveConversations(browserStorage, state.conversations);
}

function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme;
}

function setStatus(message, kind = "") {
  el.status.textContent = message;
  el.status.dataset.kind = kind;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function renderSidebar() {
  const query = state.search.trim().toLowerCase();
  const matches = state.conversations.filter((conversation) => {
    if (!query) return true;
    return conversation.title.toLowerCase().includes(query) || conversation.messages.some((message) => message.content.toLowerCase().includes(query));
  });
  el.chatList.replaceChildren();
  if (!matches.length) {
    el.chatList.appendChild(Object.assign(document.createElement("p"), { className: "empty", textContent: state.conversations.length ? "No matches." : "No chats yet." }));
    return;
  }
  for (const conversation of matches) {
    const row = document.createElement("div");
    row.className = "chat-row";
    const select = document.createElement("button");
    select.type = "button";
    select.className = `chat-item${conversation.id === state.activeId ? " active" : ""}`;
    select.dataset.id = conversation.id;
    const title = Object.assign(document.createElement("span"), { className: "chat-title", textContent: conversation.title });
    const time = Object.assign(document.createElement("span"), { className: "chat-time", textContent: formatTime(conversation.updatedAt) });
    select.append(title, time);
    const remove = Object.assign(document.createElement("button"), { type: "button", className: "delete-btn", textContent: "×" });
    remove.dataset.delete = conversation.id;
    remove.title = `Delete ${conversation.title}`;
    remove.setAttribute("aria-label", `Delete ${conversation.title}`);
    row.append(select, remove);
    el.chatList.appendChild(row);
  }
}

function renderHeader() {
  const conversation = active();
  el.chatTitle.textContent = conversation?.title ?? "New chat";
  el.modelBadge.textContent = state.settings.model;
  try {
    el.serverLabel.textContent = new URL(normalizeBaseUrl(state.settings.baseUrl)).host;
  } catch {
    el.serverLabel.textContent = "set a server";
  }
}

function addCopyButtons(root) {
  for (const pre of root.querySelectorAll("pre")) {
    const button = Object.assign(document.createElement("button"), { type: "button", className: "copy-btn", textContent: "Copy" });
    button.addEventListener("click", async () => {
      const code = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
      try {
        await navigator.clipboard.writeText(code);
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = "Copy"; }, 1200);
      } catch {
        button.textContent = "Copy failed";
      }
    });
    pre.appendChild(button);
  }
}

function welcome() {
  const box = document.createElement("div");
  box.className = "welcome";
  box.appendChild(Object.assign(document.createElement("h2"), { textContent: "ChatDuck" }));
  box.appendChild(Object.assign(document.createElement("p"), { className: "muted", textContent: `Connected to ${state.settings.baseUrl}. Ask anything, or start with one of these.` }));
  const suggestions = [
    "Explain this error in plain words.",
    "Write a function that parses a CSV line.",
    "Fix this bug and explain the cause.",
  ];
  const row = document.createElement("div");
  row.className = "suggestions";
  for (const suggestion of suggestions) {
    const button = Object.assign(document.createElement("button"), { type: "button", className: "suggestion", textContent: suggestion });
    button.dataset.prompt = suggestion;
    row.appendChild(button);
  }
  box.appendChild(row);
  return box;
}

function nearBottom(threshold = 80) {
  return isNearBottom(el.messages, threshold);
}

function updateJump() {
  const overflowing = el.messages.scrollHeight > el.messages.clientHeight + 4;
  el.jump.hidden = state.stickToBottom || !overflowing;
}

function addMessageActions(article, message, index, isLast, allowRegenerate) {
  const actions = document.createElement("div");
  actions.className = "message-actions";
  if (message.content) {
    const copy = Object.assign(document.createElement("button"), { type: "button", className: "msg-action", textContent: "Copy" });
    copy.dataset.copy = String(index);
    actions.appendChild(copy);
  }
  if (!state.streaming && isLast && allowRegenerate && message.content) {
    const again = Object.assign(document.createElement("button"), { type: "button", className: "msg-action", textContent: "Regenerate" });
    again.dataset.regenerate = "1";
    actions.appendChild(again);
  }
  if (actions.childElementCount) article.appendChild(actions);
}

function renderMessages() {
  const conversation = active();
  const previousScroll = el.messages.scrollTop;
  el.messages.replaceChildren();
  if (!conversation || !conversation.messages.length) {
    el.messages.appendChild(welcome());
    state.stickToBottom = true;
    updateJump();
    return;
  }
  const allowRegenerate = canRegenerate(conversation.messages);
  conversation.messages.forEach((message, index) => {
    const article = document.createElement("article");
    article.className = `message ${message.role}`;
    article.dataset.index = String(index);
    const role = Object.assign(document.createElement("span"), { className: "role", textContent: message.role === "user" ? "You" : "ChatDuck" });
    const body = document.createElement("div");
    body.className = "message-body";
    if (message.role === "assistant") {
      body.innerHTML = renderMarkdown(message.content);
      addCopyButtons(body);
      if (!message.content && state.streaming) {
        body.appendChild(Object.assign(document.createElement("span"), { className: "typing", textContent: "…" }));
      }
    } else {
      body.textContent = message.content;
    }
    article.append(role, body);
    addMessageActions(article, message, index, index === conversation.messages.length - 1, allowRegenerate);
    el.messages.appendChild(article);
  });
  el.messages.scrollTop = state.stickToBottom ? el.messages.scrollHeight : previousScroll;
  updateJump();
}

function renderAll() {
  renderSidebar();
  renderHeader();
  renderMessages();
}

function updateStreamingMessage() {
  const conversation = active();
  if (!conversation || !conversation.messages.length) {
    renderMessages();
    return;
  }
  const index = conversation.messages.length - 1;
  const message = conversation.messages[index];
  if (message.role !== "assistant") {
    renderMessages();
    return;
  }
  const article = el.messages.querySelector(`[data-index="${index}"]`);
  const body = article?.querySelector(".message-body");
  if (!body) {
    renderMessages();
    return;
  }
  body.innerHTML = renderMarkdown(message.content);
  addCopyButtons(body);
  if (!message.content) {
    body.appendChild(Object.assign(document.createElement("span"), { className: "typing", textContent: "…" }));
  }
  if (state.stickToBottom) el.messages.scrollTop = el.messages.scrollHeight;
  updateJump();
}

function scheduleMessages() {
  if (state.frame) return;
  state.frame = requestAnimationFrame(() => {
    state.frame = 0;
    updateStreamingMessage();
  });
}

function createChat() {
  if (state.streaming) return;
  const conversation = newConversation();
  state.conversations.unshift(conversation);
  state.activeId = conversation.id;
  state.stickToBottom = true;
  persist();
  renderAll();
  closeSidebar();
  el.prompt.focus();
}

function selectChat(id) {
  if (state.streaming) return;
  state.activeId = id;
  state.stickToBottom = true;
  renderAll();
  closeSidebar();
  el.prompt.focus();
}

function deleteChat(id) {
  if (state.streaming) return;
  const wasActive = state.activeId === id;
  state.conversations = state.conversations.filter((conversation) => conversation.id !== id);
  if (wasActive) state.activeId = state.conversations[0]?.id ?? null;
  if (wasActive) state.stickToBottom = true;
  persist();
  renderAll();
}

function setBusy(busy) {
  el.send.disabled = busy;
  el.newChat.disabled = busy;
  el.stop.hidden = !busy;
  el.prompt.setAttribute("aria-busy", String(busy));
}

async function runTurn(conversation, userText = null) {
  if (state.streaming) return;
  if (userText !== null) appendMessage(conversation, "user", userText);
  const assistant = { role: "assistant", content: "" };
  conversation.messages.push(assistant);
  conversation.updatedAt = Date.now();
  state.stickToBottom = true;
  persist();
  renderAll();
  const controller = new AbortController();
  state.streaming = controller;
  setBusy(true);
  try {
    await streamChat({
      baseUrl: state.settings.baseUrl,
      apiKey: state.apiKey,
      model: state.settings.model,
      messages: buildMessages({ systemPrompt: state.settings.systemPrompt, messages: conversation.messages.slice(0, -1) }),
      temperature: state.settings.temperature,
      maxTokens: state.settings.maxTokens,
      signal: controller.signal,
      onDelta: (_delta, full) => {
        assistant.content = full;
        scheduleMessages();
      },
    });
    if (!assistant.content) assistant.content = "_(the server returned an empty answer)_";
  } catch (error) {
    assistant.content = error?.name === "AbortError"
      ? `${assistant.content}${assistant.content ? "\n\n" : ""}_(stopped)_`
      : `⚠ ${error?.message || "The request failed."}`;
  } finally {
    state.streaming = null;
    setBusy(false);
    conversation.updatedAt = Date.now();
    persist();
    renderAll();
    el.prompt.focus();
  }
}

async function send() {
  const prompt = el.prompt.value.trim();
  if (!prompt || state.streaming) return;
  let conversation = active();
  if (!conversation) {
    conversation = newConversation();
    state.conversations.unshift(conversation);
    state.activeId = conversation.id;
  }
  el.prompt.value = "";
  resizePrompt();
  await runTurn(conversation, prompt);
}

async function regenerate() {
  if (state.streaming) return;
  const conversation = active();
  if (!conversation || !canRegenerate(conversation.messages)) return;
  removeTrailingAssistant(conversation);
  await runTurn(conversation);
}

async function copyMessage(index, button) {
  const message = active()?.messages[index];
  if (!message) return;
  try {
    await navigator.clipboard.writeText(message.content);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed";
  }
  setTimeout(() => { button.textContent = "Copy"; }, 1200);
}

function stop() {
  state.streaming?.abort();
}

function resizePrompt() {
  el.prompt.style.height = "auto";
  el.prompt.style.height = `${Math.min(200, el.prompt.scrollHeight)}px`;
}

async function refreshModels({ quiet = false } = {}) {
  try {
    const models = await listModels({ baseUrl: state.settings.baseUrl, apiKey: state.apiKey });
    state.models = models;
    el.modelOptions.replaceChildren(...models.map((model) => Object.assign(document.createElement("option"), { value: model })));
    setStatus(models.length ? `Connected · ${models.length} model${models.length === 1 ? "" : "s"}` : "Connected", "ok");
  } catch (error) {
    state.models = [];
    el.modelOptions.replaceChildren();
    setStatus("Offline · check Settings", "warn");
    if (!quiet) el.settingsStatus.textContent = error.message;
  }
}

function fillSettings() {
  el.settingUrl.value = state.settings.baseUrl;
  el.settingKey.value = state.apiKey;
  el.settingModel.value = state.settings.model;
  el.settingSystem.value = state.settings.systemPrompt;
  el.settingTemperature.value = state.settings.temperature;
  el.settingMax.value = state.settings.maxTokens;
  el.settingsStatus.textContent = "";
  el.modelOptions.replaceChildren(...state.models.map((model) => Object.assign(document.createElement("option"), { value: model })));
}

function openSettings() {
  fillSettings();
  el.dialog.showModal();
}

async function saveSettingsForm(event) {
  event.preventDefault();
  try {
    const baseUrl = normalizeBaseUrl(el.settingUrl.value);
    state.settings = saveSettings(browserStorage, normalizeSettings({
      baseUrl,
      model: el.settingModel.value,
      systemPrompt: el.settingSystem.value,
      temperature: el.settingTemperature.value,
      maxTokens: el.settingMax.value,
      theme: state.settings.theme,
    }));
    state.apiKey = el.settingKey.value.trim();
    saveApiKey(browserSession, state.apiKey);
    applyTheme();
    el.dialog.close();
    renderAll();
    void refreshModels({ quiet: true });
  } catch (error) {
    el.settingsStatus.textContent = error.message;
  }
}

async function testConnection() {
  el.settingsStatus.textContent = "Checking…";
  try {
    const baseUrl = normalizeBaseUrl(el.settingUrl.value);
    const models = await listModels({ baseUrl, apiKey: el.settingKey.value.trim() });
    el.settingsStatus.textContent = models.length ? `Connected: ${models.slice(0, 4).join(", ")}${models.length > 4 ? "…" : ""}` : "Connected, but no model is listed.";
    el.modelOptions.replaceChildren(...models.map((model) => Object.assign(document.createElement("option"), { value: model })));
  } catch (error) {
    el.settingsStatus.textContent = error.message;
  }
}

function toggleTheme() {
  state.settings = saveSettings(browserStorage, { ...state.settings, theme: state.settings.theme === "dark" ? "light" : "dark" });
  applyTheme();
}

function openSidebar() {
  el.sidebar.classList.add("open");
  el.scrim.hidden = false;
}

function closeSidebar() {
  el.sidebar.classList.remove("open");
  el.scrim.hidden = true;
}

function bind() {
  el.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void send();
  });
  el.prompt.addEventListener("input", resizePrompt);
  el.prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    }
  });
  el.stop.addEventListener("click", stop);
  el.newChat.addEventListener("click", createChat);
  el.settingsBtn.addEventListener("click", openSettings);
  el.themeBtn.addEventListener("click", toggleTheme);
  el.testConnection.addEventListener("click", () => void testConnection());
  el.settingsClose.addEventListener("click", () => el.dialog.close());
  el.settingsForm.addEventListener("submit", (event) => void saveSettingsForm(event));
  el.search.addEventListener("input", () => {
    state.search = el.search.value;
    renderSidebar();
  });
  el.chatList.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-delete]");
    if (remove) {
      deleteChat(remove.dataset.delete);
      return;
    }
    const select = event.target.closest("[data-id]");
    if (select) selectChat(select.dataset.id);
  });
  el.messages.addEventListener("click", (event) => {
    const copy = event.target.closest("[data-copy]");
    if (copy) {
      void copyMessage(Number(copy.dataset.copy), copy);
      return;
    }
    if (event.target.closest("[data-regenerate]")) {
      void regenerate();
      return;
    }
    const suggestion = event.target.closest("[data-prompt]");
    if (!suggestion) return;
    el.prompt.value = suggestion.dataset.prompt;
    resizePrompt();
    el.prompt.focus();
  });
  el.messages.addEventListener("scroll", () => {
    const stick = nearBottom();
    if (stick !== state.stickToBottom) {
      state.stickToBottom = stick;
      updateJump();
    }
  });
  el.jump.addEventListener("click", () => {
    state.stickToBottom = true;
    el.messages.scrollTop = el.messages.scrollHeight;
    updateJump();
  });
  el.menu.addEventListener("click", openSidebar);
  el.scrim.addEventListener("click", closeSidebar);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSidebar();
  });
}

applyTheme();
bind();
if (state.conversations.length) state.activeId = state.conversations[0].id;
renderAll();
void refreshModels({ quiet: true });
el.prompt.focus();
