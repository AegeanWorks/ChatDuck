/**
 * Pure chat-view predicates, kept out of the DOM so they can be tested in Node.
 */

/** Regeneration replays one user turn, so only a trailing assistant answer qualifies. */
export function canRegenerate(messages) {
  return Array.isArray(messages)
    && messages.length >= 2
    && messages.at(-1)?.role === "assistant"
    && messages.at(-2)?.role === "user";
}

/** True when the scroll box is within `threshold` pixels of the latest message. */
export function isNearBottom({ scrollHeight = 0, scrollTop = 0, clientHeight = 0 } = {}, threshold = 80) {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
