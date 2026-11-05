import assert from "node:assert/strict";
import test from "node:test";

import { canEditMessage, canRegenerate, editReplayFrom, isNearBottom, modelOptions } from "../public/chat.js";

test("regenerate is offered only for an assistant answer that follows a user turn", () => {
  assert.equal(canRegenerate([{ role: "user" }, { role: "assistant" }]), true);
  assert.equal(canRegenerate([{ role: "assistant" }, { role: "user" }]), false);
  assert.equal(canRegenerate([{ role: "user" }]), false);
  assert.equal(canRegenerate([{ role: "assistant" }]), false);
  assert.equal(canRegenerate([]), false);
  assert.equal(canRegenerate(null), false);
});

test("error answers offer a retry and user turns offer edit", () => {
  assert.equal(canRegenerate([{ role: "user" }, { role: "assistant", content: "⚠ boom" }]), true);
  assert.equal(canEditMessage({ role: "user", content: "hi" }), true);
  assert.equal(canEditMessage({ role: "assistant", content: "hi" }), false);
  assert.equal(editReplayFrom([{ role: "user" }], 0), true);
  assert.equal(editReplayFrom([{ role: "assistant" }], 0), false);
});

test("consecutive assistant turns do not offer a regenerate that would no-op", () => {
  assert.equal(canRegenerate([
    { role: "user" },
    { role: "assistant" },
    { role: "assistant" },
  ]), false);
});

test("the model picker lists the current model first and dedupes", () => {
  assert.deepEqual(modelOptions("b", ["a", "b", "a"]), ["b", "a"]);
  assert.deepEqual(modelOptions("  b ", [null, "", "b"]), ["b"]);
  assert.deepEqual(modelOptions("", []), []);
  assert.deepEqual(modelOptions(null, ["a"]), ["a"]);
});

test("the scroll box is near the bottom only within the threshold", () => {
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 420, clientHeight: 500 }), true);
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 419, clientHeight: 500 }), false);
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 }, 0), true);
  assert.equal(isNearBottom({}, 80), true);
});

test("error retry still needs a user turn to replay", () => {
  assert.equal(canRegenerate([{ role: "assistant", content: "⚠ boom" }, { role: "assistant", content: "⚠ boom" }]), false);
  assert.equal(canRegenerate([{ role: "user", content: "hi" }, { role: "assistant", content: "⚠ boom" }]), true);
});

test("a null scroll state does not throw", () => {
  assert.doesNotThrow(() => isNearBottom(null));
  assert.doesNotThrow(() => isNearBottom(undefined));
});
