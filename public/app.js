import { buildMessages, estimateTokens, isTextFile, listModels, MAX_TEXT_FILES, MAX_TEXT_READ_BYTES, normalizeBaseUrl, streamChat, suggestTitle, titleFrom, wrapTextAttachment } from "./openai.js";
import { extractThinking, renderMarkdown } from "./markdown.js";
import { canEditMessage, canRegenerate, isNearBottom, modelOptions } from "./chat.js";
import {
  allConversationsToJSON,
  appendMessage,
  contextUsage,
  conversationFromJSON,
  conversationsFromJSON,
  conversationToJSON,
  conversationToMarkdown,
  deleteMessageAt,
  duplicateConversation,
  editUserMessage,
  loadApiKey,
  loadConversations,
  loadSettings,
  MAX_IMAGES_PER_MESSAGE,
  newConversation,
  normalizeSettings,
  removeTrailingAssistant,
  renameConversation,
  saveApiKey,
  saveConversations,
  saveSettings,
  sortConversations,
  togglePin,
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
  settingTopP: $("setting-topp"),
  settingThinking: $("setting-thinking"),
  settingAutoTitle: $("setting-autotitle"),
  settingMax: $("setting-max"),
  chatStats: $("chat-stats"),
  renameBtn: $("rename-btn"),
  duplicateBtn: $("duplicate-btn"),
  exportBtn: $("export-btn"),
  downloadBtn: $("download-btn"),
  promptCount: $("prompt-count"),
  settingsStatus: $("settings-status"),
  testConnection: $("test-connection"),
  settingsClose: $("settings-close"),
  attachBtn: $("attach-btn"),
  attachFile: $("attach-file"),
  attachStrip: $("attach-strip"),
  importBtn: $("import-btn"),
  importFile: $("import-file"),
  settingFreq: $("setting-freq"),
  settingPresence: $("setting-presence"),
  settingSeed: $("setting-seed"),
  settingPreset: $("setting-preset"),
  backupBtn: $("backup-btn"),
  clearAllBtn: $("clear-all-btn"),
  ctxFill: $("ctx-fill"),
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
  editingIndex: null,
  pendingImages: [],
  pendingTexts: [],
};

const active = () => state.conversations.find((conversation) => conversation.id === state.activeId) ?? null;

function persist() {
  // Save a normalized copy, but keep the live objects: a streamed answer holds
  // a reference to the assistant message while deltas arrive.
  state.conversations = sortConversations(state.conversations);
  saveConversations(browserStorage, state.conversations);
}

const SYSTEM_PRESETS = Object.freeze([
  { id: "custom", label: "Custom", text: "" },
  { id: "concise", label: "Concise coding assistant", text: "You are a concise coding assistant. Answer directly with working code first, then a one-line explanation only when the cause is non-obvious." },
  { id: "explainer", label: "Plain-language explainer", text: "You explain things in plain words for a smart beginner. Use short sentences, one small example, and define any jargon you use." },
  { id: "reviewer", label: "Careful code reviewer", text: "You are a careful code reviewer. Point out bugs, edge cases and security issues first, then suggest the smallest fix." },
  { id: "summarizer", label: "Sharp summarizer", text: "You summarize clearly. Lead with a one-paragraph bottom line, then a short bullet list of key points." },
]);

const THEME_LABEL = Object.freeze({ dark: "🌙 Dark", light: "☀️ Light", auto: "💻 Auto" });
const THEME_ORDER = Object.freeze(["dark", "light", "auto"]);

function resolveTheme() {
  if (state.settings.theme !== "auto") return state.settings.theme;
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = resolveTheme();
  if (el.themeBtn) {
    el.themeBtn.textContent = THEME_LABEL[state.settings.theme] ?? THEME_LABEL.dark;
    el.themeBtn.title = `Theme: ${state.settings.theme} (click to switch)`;
  }
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
    row.className = `chat-row${conversation.pinned ? " pinned" : ""}`;
    const select = document.createElement("button");
    select.type = "button";
    select.className = `chat-item${conversation.id === state.activeId ? " active" : ""}`;
    select.dataset.id = conversation.id;
    const title = Object.assign(document.createElement("span"), { className: "chat-title", textContent: `${conversation.pinned ? "📌 " : ""}${conversation.title}` });
    const time = Object.assign(document.createElement("span"), { className: "chat-time", textContent: formatTime(conversation.updatedAt) });
    select.append(title, time);
    const pin = Object.assign(document.createElement("button"), { type: "button", className: "pin-btn", textContent: conversation.pinned ? "★" : "☆" });
    pin.dataset.pin = conversation.id;
    pin.title = conversation.pinned ? `Unpin ${conversation.title}` : `Pin ${conversation.title}`;
    pin.setAttribute("aria-label", pin.title);
    pin.setAttribute("aria-pressed", String(Boolean(conversation.pinned)));
    const remove = Object.assign(document.createElement("button"), { type: "button", className: "delete-btn", textContent: "×" });
    remove.dataset.delete = conversation.id;
    remove.title = `Delete ${conversation.title}`;
    remove.setAttribute("aria-label", `Delete ${conversation.title}`);
    row.append(select, pin, remove);
    el.chatList.appendChild(row);
  }
}

function renderHeader() {
  const conversation = active();
  el.chatTitle.textContent = conversation?.title ?? "New chat";
  el.modelBadge.replaceChildren(...modelOptions(state.settings.model, state.models).map((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    return option;
  }));
  el.modelBadge.value = state.settings.model;
  el.modelBadge.title = `Model: ${state.settings.model} (change to switch)`;
  el.modelBadge.disabled = Boolean(state.streaming);
  try {
    el.serverLabel.textContent = new URL(normalizeBaseUrl(state.settings.baseUrl)).host;
  } catch {
    el.serverLabel.textContent = "set a server";
  }
  const hasChat = Boolean(conversation?.messages?.length);
  if (hasChat) {
    const ctx = contextUsage(conversation, state.settings.maxTokens);
    el.chatStats.textContent = `~${ctx.used} tok · ${ctx.percent}% of reply budget`;
    el.chatStats.title = `Estimated context vs the max-tokens reply budget (${ctx.used}/${ctx.budget})`;
    if (el.ctxFill) {
      el.ctxFill.style.width = `${ctx.percent}%`;
      el.ctxFill.dataset.hot = ctx.percent >= 80 ? "1" : "";
    }
  } else {
    el.chatStats.textContent = "";
    el.chatStats.title = "";
    if (el.ctxFill) {
      el.ctxFill.style.width = "0%";
      el.ctxFill.dataset.hot = "";
    }
  }
  for (const button of [el.renameBtn, el.duplicateBtn, el.exportBtn, el.downloadBtn]) {
    if (button) button.disabled = !conversation;
  }
}

function renderCounter() {
  const extras = state.pendingTexts.reduce((sum, file) => sum + file.content.length, 0);
  const length = el.prompt.value.length + extras;
  const bits = [];
  if (state.pendingImages.length) bits.push(`${state.pendingImages.length} img`);
  if (state.pendingTexts.length) bits.push(`${state.pendingTexts.length} file${state.pendingTexts.length === 1 ? "" : "s"}`);
  const suffix = bits.length ? ` · ${bits.join(" · ")}` : "";
  const tokens = estimateTokens(el.prompt.value) + Math.ceil(extras / 4);
  el.promptCount.textContent = length || bits.length ? `${length} chars · ~${tokens} tok${suffix}` : "";
}

function pendingAttachmentCount() {
  return state.pendingImages.length + state.pendingTexts.length;
}

function renderAttachStrip() {
  el.attachStrip.replaceChildren();
  state.pendingImages.forEach((url, index) => {
    const wrap = document.createElement("span");
    wrap.className = "attach-thumb";
    const img = document.createElement("img");
    img.src = url;
    img.alt = `Attached image ${index + 1}`;
    const remove = Object.assign(document.createElement("button"), { type: "button", className: "attach-remove", textContent: "×" });
    remove.dataset.removeAttach = String(index);
    remove.setAttribute("aria-label", `Remove image ${index + 1}`);
    wrap.append(img, remove);
    el.attachStrip.appendChild(wrap);
  });
  state.pendingTexts.forEach((file, index) => {
    const chip = document.createElement("span");
    chip.className = "attach-chip";
    chip.append(
      Object.assign(document.createElement("span"), { className: "attach-chip-icon", textContent: "📄" }),
      Object.assign(document.createElement("span"), { className: "attach-chip-name", textContent: file.name }),
    );
    const remove = Object.assign(document.createElement("button"), { type: "button", className: "attach-remove", textContent: "×" });
    remove.dataset.removeText = String(index);
    remove.setAttribute("aria-label", `Remove file ${file.name}`);
    chip.appendChild(remove);
    el.attachStrip.appendChild(chip);
  });
  el.attachStrip.hidden = !pendingAttachmentCount();
  renderCounter();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });
}

/** Downscale to a max side of 1568px so vision prompts stay fast and small. */
async function fileToVisionUrl(file) {
  const original = await readFileAsDataUrl(file);
  if (!original.startsWith("data:image/")) throw new Error("Only image files can be attached.");
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return original;
  const maxSide = 1568;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  if (scale >= 1) {
    bitmap.close?.();
    return original;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close?.();
    return original;
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", 0.85);
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read that file."));
    // Cap the raw read so a huge log cannot freeze the tab; the wrapper
    // truncates to the smaller char cap with a visible note.
    reader.readAsText(file.slice(0, MAX_TEXT_READ_BYTES));
  });
}

/** Images go to vision, text files are inlined; anything else is rejected. */
async function addAttachmentFiles(files) {
  const list = [...(files ?? [])].filter(Boolean);
  if (!list.length) return;
  let added = 0;
  for (const file of list) {
    if (file?.type?.startsWith("image/")) {
      if (state.pendingImages.length >= MAX_IMAGES_PER_MESSAGE) {
        setStatus(`At most ${MAX_IMAGES_PER_MESSAGE} images per message.`, "warn");
        break;
      }
      try {
        state.pendingImages.push(await fileToVisionUrl(file));
        added += 1;
      } catch {
        setStatus("Could not read that image.", "warn");
      }
    } else if (isTextFile(file)) {
      if (state.pendingTexts.length >= MAX_TEXT_FILES) {
        setStatus(`At most ${MAX_TEXT_FILES} text files per message.`, "warn");
        break;
      }
      try {
        state.pendingTexts.push({ name: file.name || "file.txt", content: await readFileAsText(file) });
        added += 1;
      } catch {
        setStatus("Could not read that file.", "warn");
      }
    } else if (added === 0) {
      setStatus("Only images and text files (.txt, .md, .json, code…) can be attached.", "warn");
    }
  }
  renderAttachStrip();
  el.prompt.focus();
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
  if (state.streaming) {
    if (actions.childElementCount) article.appendChild(actions);
    return;
  }
  if (message.content) {
    const copy = Object.assign(document.createElement("button"), { type: "button", className: "msg-action", textContent: "Copy" });
    copy.dataset.copy = String(index);
    actions.appendChild(copy);
  }
  if (canEditMessage(message)) {
    const edit = Object.assign(document.createElement("button"), { type: "button", className: "msg-action", textContent: "Edit" });
    edit.dataset.edit = String(index);
    actions.appendChild(edit);
  }
  const remove = Object.assign(document.createElement("button"), { type: "button", className: "msg-action danger", textContent: "Delete" });
  remove.dataset.deleteMessage = String(index);
  actions.appendChild(remove);
  if (isLast && allowRegenerate && message.content) {
    const again = Object.assign(document.createElement("button"), { type: "button", className: "msg-action", textContent: message.content.startsWith("⚠") ? "Retry" : "Regenerate" });
    again.dataset.regenerate = "1";
    actions.appendChild(again);
  }
  if (actions.childElementCount) article.appendChild(actions);
}

function thinkingNode(reasoning, open) {
  const details = document.createElement("details");
  details.className = "thinking";
  if (open) details.open = true;
  const summary = Object.assign(document.createElement("summary"), { textContent: open ? "Thinking…" : "Thinking" });
  const body = document.createElement("div");
  body.className = "thinking-body";
  body.innerHTML = renderMarkdown(reasoning || "…");
  details.append(summary, body);
  return details;
}

function statsLine(message) {
  const parts = [];
  if (Number.isFinite(message.elapsedMs)) parts.push(`${(message.elapsedMs / 1000).toFixed(1)}s`);
  if (Number.isFinite(message.tokensPerSecond) && message.tokensPerSecond > 0) parts.push(`${message.tokensPerSecond.toFixed(1)} tok/s`);
  const server = message.usage;
  if (server && (Number.isFinite(server.prompt) || Number.isFinite(server.completion))) {
    const bits = [];
    if (Number.isFinite(server.prompt)) bits.push(`${server.prompt} in`);
    if (Number.isFinite(server.completion)) bits.push(`${server.completion} out`);
    parts.push(`server ${bits.join(" · ")}`);
  } else if (message.content) {
    parts.push(`~${estimateTokens(message.content)} tok`);
  }
  if (!parts.length) return null;
  return Object.assign(document.createElement("span"), { className: "stats muted", textContent: parts.join(" · ") });
}

function renderEditBox(article, message, index) {
  const box = document.createElement("div");
  box.className = "edit-box";
  const area = document.createElement("textarea");
  area.value = message.content;
  area.rows = Math.min(12, Math.max(3, message.content.split("\n").length + 1));
  area.setAttribute("aria-label", "Edit message");
  const row = document.createElement("div");
  row.className = "edit-row";
  const save = Object.assign(document.createElement("button"), { type: "button", className: "primary-btn small", textContent: "Save & resend" });
  save.dataset.saveEdit = String(index);
  const cancel = Object.assign(document.createElement("button"), { type: "button", className: "ghost-btn small", textContent: "Cancel" });
  cancel.dataset.cancelEdit = "1";
  const hint = Object.assign(document.createElement("span"), { className: "muted", textContent: "Saves, drops later replies, and resends." });
  row.append(save, cancel, hint);
  box.append(area, row);
  article.appendChild(box);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
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
    const role = document.createElement("span");
    role.className = "role";
    role.textContent = message.role === "user" ? "You" : "ChatDuck";
    if (Number.isFinite(Number(message.ts))) {
      const time = document.createElement("time");
      const date = new Date(Number(message.ts));
      time.dateTime = date.toISOString();
      time.textContent = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      time.title = date.toLocaleString();
      role.append(" · ", time);
    }
    const body = document.createElement("div");
    body.className = "message-body";
    if (message.role === "assistant") {
      const inlineThink = extractThinking(message.content);
      const reasoning = message.reasoning || inlineThink.thinking;
      if (reasoning && state.settings.showThinking) {
        body.appendChild(thinkingNode(reasoning, Boolean(state.streaming && index === conversation.messages.length - 1)));
      }
      const visible = message.reasoning ? message.content : inlineThink.visible;
      const rendered = document.createElement("div");
      rendered.className = "rendered";
      rendered.innerHTML = renderMarkdown(visible);
      body.appendChild(rendered);
      addCopyButtons(body);
      if (!message.content && state.streaming) {
        body.appendChild(Object.assign(document.createElement("span"), { className: "typing", textContent: "…" }));
      }
      const stats = statsLine(message);
      if (stats) body.appendChild(stats);
    } else if (state.editingIndex === index) {
      body.textContent = message.content;
    } else {
      if (message.images?.length) {
        const gallery = document.createElement("div");
        gallery.className = "gallery";
        for (const url of message.images.slice(0, MAX_IMAGES_PER_MESSAGE)) {
          if (typeof url !== "string" || !url.startsWith("data:image/")) continue;
          const img = document.createElement("img");
          img.src = url;
          img.alt = "Attached image";
          img.loading = "lazy";
          gallery.appendChild(img);
        }
        if (gallery.childElementCount) body.appendChild(gallery);
      }
      const text = document.createElement("div");
      text.textContent = message.content || "_(images only)_";
      body.appendChild(text);
    }
    article.append(role, body);
    if (state.editingIndex === index && message.role === "user") {
      renderEditBox(article, message, index);
    } else {
      addMessageActions(article, message, index, index === conversation.messages.length - 1, allowRegenerate);
    }
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
  body.replaceChildren();
  const inlineThink = extractThinking(message.content);
  const reasoning = message.reasoning || inlineThink.thinking;
  if (reasoning && state.settings.showThinking) {
    body.appendChild(thinkingNode(reasoning, true));
  }
  const visible = message.reasoning ? message.content : inlineThink.visible;
  const rendered = document.createElement("div");
  rendered.innerHTML = renderMarkdown(visible);
  addCopyButtons(rendered);
  if (!message.content) {
    rendered.appendChild(Object.assign(document.createElement("span"), { className: "typing", textContent: "…" }));
  }
  body.append(rendered);
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
  state.editingIndex = null;
  persist();
  renderAll();
  closeSidebar();
  el.prompt.focus();
}

function selectChat(id) {
  if (state.streaming) return;
  state.activeId = id;
  state.stickToBottom = true;
  state.editingIndex = null;
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
  state.editingIndex = null;
  persist();
  renderAll();
}

function pinChat(id) {
  if (state.streaming) return;
  const conversation = state.conversations.find((item) => item.id === id);
  if (!conversation) return;
  togglePin(conversation);
  persist();
  renderAll();
}

function setBusy(busy) {
  el.send.disabled = busy;
  el.newChat.disabled = busy;
  el.modelBadge.disabled = busy;
  el.stop.hidden = !busy;
  el.prompt.setAttribute("aria-busy", String(busy));
}

async function runTurn(conversation, userText = null, images = []) {
  if (state.streaming) return;
  if (userText !== null) appendMessage(conversation, "user", userText, Date.now(), images);
  const assistant = { role: "assistant", content: "", reasoning: "", ts: Date.now() };
  conversation.messages.push(assistant);
  conversation.updatedAt = Date.now();
  state.stickToBottom = true;
  state.editingIndex = null;
  persist();
  renderAll();
  const controller = new AbortController();
  state.streaming = controller;
  setBusy(true);
  const started = performance.now();
  try {
    await streamChat({
      baseUrl: state.settings.baseUrl,
      apiKey: state.apiKey,
      model: state.settings.model,
      messages: buildMessages({ systemPrompt: state.settings.systemPrompt, messages: conversation.messages.slice(0, -1) }),
      temperature: state.settings.temperature,
      topP: state.settings.topP,
      frequencyPenalty: state.settings.frequencyPenalty,
      presencePenalty: state.settings.presencePenalty,
      seed: state.settings.seed,
      maxTokens: state.settings.maxTokens,
      signal: controller.signal,
      onDelta: (_delta, full) => {
        assistant.content = full;
        scheduleMessages();
      },
      onReasoning: (_delta, full) => {
        assistant.reasoning = full;
        scheduleMessages();
      },
      onUsage: (usage) => {
        assistant.usage = usage;
        scheduleMessages();
      },
    });
    if (!assistant.content && assistant.reasoning) {
      // Reasoning-only trace: keep it visible instead of an empty bubble.
      assistant.content = "_(the server returned reasoning without a final answer)_";
    } else if (!assistant.content) {
      assistant.content = "_(the server returned an empty answer)_";
    }
    if (!assistant.reasoning) delete assistant.reasoning;
  } catch (error) {
    assistant.content = error?.name === "AbortError"
      ? `${assistant.content}${assistant.content ? "\n\n" : ""}_(stopped)_`
      : `⚠ ${error?.message || "The request failed."} — fix Settings or press Retry.`;
    if (!assistant.reasoning) delete assistant.reasoning;
    if (!assistant.usage) delete assistant.usage;
  } finally {
    const elapsedMs = Math.round(performance.now() - started);
    assistant.elapsedMs = elapsedMs;
    const tokens = estimateTokens(assistant.content);
    assistant.tokensPerSecond = elapsedMs > 0 ? tokens / (elapsedMs / 1000) : 0;
    state.streaming = null;
    setBusy(false);
    conversation.updatedAt = Date.now();
    persist();
    renderAll();
    el.prompt.focus();
    void maybeAutoTitle(conversation);
  }
}

/** Best-effort AI title after the first exchange; keeps the first-line title on any failure. */
async function maybeAutoTitle(conversation) {
  if (!state.settings.autoTitle || !conversation) return;
  if (conversation.messages.length !== 2) return;
  const first = conversation.messages[0];
  const reply = conversation.messages[1];
  if (!first || first.role !== "user" || !String(first.content).trim()) return;
  if (!reply || reply.role !== "assistant" || String(reply.content).startsWith("⚠")) return;
  // Skip when the user already renamed the chat mid-flight.
  if (conversation.title !== titleFrom(first.content)) return;
  try {
    const title = await suggestTitle({
      baseUrl: state.settings.baseUrl,
      apiKey: state.apiKey,
      model: state.settings.model,
      userText: first.content,
    });
    if (!title || title === "New chat") return;
    if (!state.conversations.includes(conversation) || conversation.title !== titleFrom(first.content)) return;
    conversation.title = title;
    conversation.updatedAt = Date.now();
    persist();
    renderSidebar();
    renderHeader();
  } catch {
    // Best-effort: the first-line title stays.
  }
}

async function send() {
  const prompt = el.prompt.value.trim();
  const images = [...state.pendingImages];
  const textBlocks = state.pendingTexts.map((file) => wrapTextAttachment(file.name, file.content)).join("\n\n");
  const full = [prompt, textBlocks].filter(Boolean).join("\n\n");
  if ((!full && !images.length) || state.streaming) return;
  let conversation = active();
  if (!conversation) {
    conversation = newConversation();
    state.conversations.unshift(conversation);
    state.activeId = conversation.id;
  }
  el.prompt.value = "";
  state.pendingImages = [];
  state.pendingTexts = [];
  renderAttachStrip();
  resizePrompt();
  await runTurn(conversation, full || "(images)", images);
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

function startEdit(index) {
  if (state.streaming) return;
  state.editingIndex = Number(index);
  renderMessages();
}

function cancelEdit() {
  state.editingIndex = null;
  renderMessages();
  el.prompt.focus();
}

async function saveEdit(index, article) {
  const conversation = active();
  if (!conversation || state.streaming) return;
  const area = article?.querySelector("textarea");
  const next = area?.value ?? "";
  if (!next.trim()) {
    cancelEdit();
    return;
  }
  editUserMessage(conversation, Number(index), next);
  state.editingIndex = null;
  persist();
  renderAll();
  await runTurn(conversation);
}

function deleteOneMessage(index) {
  if (state.streaming) return;
  const conversation = active();
  if (!conversation) return;
  if (state.editingIndex !== null) {
    state.editingIndex = null;
  }
  deleteMessageAt(conversation, Number(index));
  persist();
  renderAll();
}

async function renameActiveChat() {
  const conversation = active();
  if (!conversation || state.streaming) return;
  const next = window.prompt("Rename chat", conversation.title);
  if (next === null) return;
  renameConversation(conversation, next);
  persist();
  renderAll();
}

function duplicateActiveChat() {
  const conversation = active();
  if (!conversation || state.streaming) return;
  const copy = duplicateConversation(conversation);
  state.conversations.unshift(copy);
  state.activeId = copy.id;
  state.stickToBottom = true;
  state.editingIndex = null;
  persist();
  renderAll();
}

async function exportActiveChat(button) {
  const conversation = active();
  if (!conversation) return;
  try {
    await navigator.clipboard.writeText(conversationToMarkdown(conversation));
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed";
  }
  setTimeout(() => { button.textContent = "Export"; }, 1200);
}

function downloadActiveChat() {
  const conversation = active();
  if (!conversation) return;
  const blob = new Blob([conversationToMarkdown(conversation)], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const safe = (conversation.title || "chat").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "chat";
  link.href = url;
  link.download = `${safe}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stop() {
  state.streaming?.abort();
}

function resizePrompt() {
  el.prompt.style.height = "auto";
  el.prompt.style.height = `${Math.min(200, el.prompt.scrollHeight)}px`;
  renderCounter();
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
  renderHeader();
}

function fillSettings() {
  el.settingUrl.value = state.settings.baseUrl;
  el.settingKey.value = state.apiKey;
  el.settingModel.value = state.settings.model;
  el.settingSystem.value = state.settings.systemPrompt;
  el.settingPreset.replaceChildren(...SYSTEM_PRESETS.map((preset) => {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.label;
    return option;
  }));
  el.settingPreset.value = SYSTEM_PRESETS.find((preset) => preset.id !== "custom" && preset.text === state.settings.systemPrompt)?.id ?? "custom";
  el.settingTemperature.value = state.settings.temperature;
  el.settingTopP.value = state.settings.topP;
  el.settingFreq.value = state.settings.frequencyPenalty;
  el.settingPresence.value = state.settings.presencePenalty;
  el.settingSeed.value = state.settings.seed;
  el.settingThinking.checked = state.settings.showThinking !== false;
  el.settingAutoTitle.checked = state.settings.autoTitle === true;
  el.settingMax.value = state.settings.maxTokens;
  el.settingsStatus.textContent = "";
  el.modelOptions.replaceChildren(...state.models.map((model) => Object.assign(document.createElement("option"), { value: model })));
}

function openSettings() {
  fillSettings();
  el.dialog.showModal();
  // Model lists go stale when servers load/unload models; refresh on open.
  void refreshModels({ quiet: true });
}

async function importChatFile(file) {
  if (!file) return;
  try {
    const raw = await file.text();
    let imported;
    try {
      imported = conversationsFromJSON(raw);
    } catch {
      imported = [conversationFromJSON(raw)];
    }
    const fresh = [];
    for (const conversation of imported) {
      if (state.conversations.some((existing) => existing.id === conversation.id)) {
        conversation.id = globalThis.crypto?.randomUUID?.() ?? `import-${Date.now()}-${fresh.length}`;
      }
      fresh.push(conversation);
    }
    state.conversations.unshift(...fresh);
    state.activeId = fresh[0].id;
    state.stickToBottom = true;
    state.editingIndex = null;
    persist();
    renderAll();
    setStatus(fresh.length > 1 ? `${fresh.length} chats imported.` : "Chat imported.", "ok");
  } catch (error) {
    setStatus(error?.message || "Could not import that file.", "warn");
  }
}

function downloadBackup() {
  if (!state.conversations.length) {
    setStatus("Nothing to back up yet.", "warn");
    return;
  }
  const blob = new Blob([allConversationsToJSON(state.conversations)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `chatduck-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus("Backup downloaded.", "ok");
}

function clearAllChats() {
  if (!state.conversations.length || state.streaming) return;
  const confirmed = window.confirm(`Delete all ${state.conversations.length} chats? This cannot be undone. Download a backup first if needed.`);
  if (!confirmed) return;
  state.conversations = [];
  state.activeId = null;
  state.stickToBottom = true;
  state.editingIndex = null;
  persist();
  renderAll();
  el.dialog.close();
  setStatus("All chats deleted.", "warn");
}

function downloadJSON() {
  const conversation = active();
  if (!conversation) return;
  const blob = new Blob([conversationToJSON(conversation)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const safe = (conversation.title || "chat").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "chat";
  link.href = url;
  link.download = `${safe}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      topP: el.settingTopP.value,
      frequencyPenalty: el.settingFreq.value,
      presencePenalty: el.settingPresence.value,
      seed: el.settingSeed.value,
      showThinking: el.settingThinking.checked,
      autoTitle: el.settingAutoTitle.checked,
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
  const current = THEME_ORDER.indexOf(state.settings.theme);
  const next = THEME_ORDER[(current + 1) % THEME_ORDER.length] ?? "dark";
  state.settings = saveSettings(browserStorage, { ...state.settings, theme: next });
  applyTheme();
}

function openSidebar() {
  el.sidebar.classList.add("open");
  // The scrim only exists on narrow screens where the sidebar is off-canvas;
  // on desktop it would just darken the app for no reason.
  try {
    el.scrim.hidden = !window.matchMedia("(max-width: 760px)").matches;
  } catch {
    el.scrim.hidden = false;
  }
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
    const pin = event.target.closest("[data-pin]");
    if (pin) {
      pinChat(pin.dataset.pin);
      return;
    }
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
    const edit = event.target.closest("[data-edit]");
    if (edit) {
      startEdit(edit.dataset.edit);
      return;
    }
    const save = event.target.closest("[data-save-edit]");
    if (save) {
      void saveEdit(save.dataset.saveEdit, save.closest("article"));
      return;
    }
    if (event.target.closest("[data-cancel-edit]")) {
      cancelEdit();
      return;
    }
    const del = event.target.closest("[data-delete-message]");
    if (del) {
      deleteOneMessage(del.dataset.deleteMessage);
      return;
    }
    if (event.target.closest("[data-regenerate]")) {
      void regenerate();
      return;
    }
    const suggestion = event.target.closest("[data-prompt]");
    if (!suggestion) return;
    // One click starts the chat, like modern assistants.
    el.prompt.value = suggestion.dataset.prompt;
    resizePrompt();
    el.prompt.focus();
    void send();
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
  el.modelBadge.addEventListener("change", () => {
    if (state.streaming) {
      renderHeader();
      return;
    }
    const next = el.modelBadge.value.trim();
    if (!next || next === state.settings.model) return;
    state.settings = saveSettings(browserStorage, { ...state.settings, model: next });
    renderAll();
  });
  el.renameBtn.addEventListener("click", () => void renameActiveChat());
  el.duplicateBtn.addEventListener("click", duplicateActiveChat);
  el.exportBtn.addEventListener("click", (event) => void exportActiveChat(event.currentTarget));
  el.downloadBtn.addEventListener("click", (event) => {
    // Shift-click downloads JSON (with images); plain click downloads Markdown.
    if (event.shiftKey) downloadJSON();
    else downloadActiveChat();
  });
  el.downloadBtn.title = "Download as Markdown (Shift-click for JSON)";
  el.attachBtn.addEventListener("click", () => el.attachFile.click());
  el.attachFile.addEventListener("change", () => {
    void addAttachmentFiles(el.attachFile.files).finally(() => { el.attachFile.value = ""; });
  });
  el.attachStrip.addEventListener("click", (event) => {
    const removeImage = event.target.closest("[data-remove-attach]");
    if (removeImage) {
      state.pendingImages.splice(Number(removeImage.dataset.removeAttach), 1);
      renderAttachStrip();
      return;
    }
    const removeText = event.target.closest("[data-remove-text]");
    if (!removeText) return;
    state.pendingTexts.splice(Number(removeText.dataset.removeText), 1);
    renderAttachStrip();
  });
  el.composer.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length) {
      event.preventDefault();
      void addAttachmentFiles(files);
    }
  });
  el.composer.addEventListener("dragover", (event) => {
    if ([...(event.dataTransfer?.types ?? [])].includes("Files")) event.preventDefault();
  });
  el.composer.addEventListener("drop", (event) => {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) {
      event.preventDefault();
      void addAttachmentFiles(files);
    }
  });
  el.importBtn.addEventListener("click", () => el.importFile.click());
  el.backupBtn.addEventListener("click", downloadBackup);
  el.clearAllBtn.addEventListener("click", clearAllChats);
  el.importFile.addEventListener("change", () => {
    void importChatFile(el.importFile.files?.[0]).finally(() => { el.importFile.value = ""; });
  });
  el.settingPreset.addEventListener("change", () => {
    const preset = SYSTEM_PRESETS.find((item) => item.id === el.settingPreset.value);
    if (preset && preset.id !== "custom") el.settingSystem.value = preset.text;
    el.settingSystem.focus();
  });
  try {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      if (state.settings.theme === "auto") applyTheme();
    });
  } catch {
    // Older browsers without matchMedia listeners keep the last applied theme.
  }
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      createChat();
      return;
    }
    if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const typing = /^(input|textarea|select)$/i.test(document.activeElement?.tagName ?? "");
      if (!typing && !el.dialog.open) {
        event.preventDefault();
        openSidebar();
        el.search.focus();
        return;
      }
    }
    if (event.key === "Escape") {
      if (state.editingIndex !== null) cancelEdit();
      else if (state.streaming) stop();
      else closeSidebar();
    }
  });
}

applyTheme();
bind();
if (state.conversations.length) state.activeId = state.conversations[0].id;
renderAll();
renderCounter();
void refreshModels({ quiet: true });
el.prompt.focus();
