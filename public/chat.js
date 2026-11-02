/**
 * Pure chat-view predicates, kept out of the DOM so they can be tested in Node.
 */

/** Regeneration replays one user turn, so only a trailing assistant answer qualifies. */
export function canRegenerate(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return false;
  const last = messages.at(-1);
  if (last?.role !== "assistant") return false;
  // Error placeholders (⚠ ...) are retryable even without a user turn behind
  // them, but real answers need a user turn to replay.
  if (typeof last.content === "string" && last.content.startsWith("⚠")) return true;
  return messages.at(-2)?.role === "user";
}

/** Any user turn can be edited; any turn can be deleted (unless streaming). */
export function canEditMessage(message) {
  return message?.role === "user" && typeof message?.content === "string";
}

/** Editing replays from `index`, so it needs a user turn with something after it trimmed. */
export function editReplayFrom(messages, index) {
  const at = Number(index);
  if (!Array.isArray(messages) || !Number.isInteger(at)) return false;
  return messages[at]?.role === "user";
}

/** True when the scroll box is within `threshold` pixels of the latest message. */
export function isNearBottom({ scrollHeight = 0, scrollTop = 0, clientHeight = 0 } = {}, threshold = 80) {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/** Model picker options: the configured model first, then the server list, deduplicated. */
export function modelOptions(current, models) {
  const seen = new Set();
  const out = [];
  for (const id of [current, ...(Array.isArray(models) ? models : [])]) {
    const name = String(id ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
