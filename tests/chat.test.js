import assert from "node:assert/strict";
import test from "node:test";

import { canRegenerate, isNearBottom } from "../public/chat.js";

test("regenerate is offered only for an assistant answer that follows a user turn", () => {
  assert.equal(canRegenerate([{ role: "user" }, { role: "assistant" }]), true);
  assert.equal(canRegenerate([{ role: "assistant" }, { role: "user" }]), false);
  assert.equal(canRegenerate([{ role: "user" }]), false);
  assert.equal(canRegenerate([{ role: "assistant" }]), false);
  assert.equal(canRegenerate([]), false);
  assert.equal(canRegenerate(null), false);
});

test("consecutive assistant turns do not offer a regenerate that would no-op", () => {
  assert.equal(canRegenerate([
    { role: "user" },
    { role: "assistant" },
    { role: "assistant" },
  ]), false);
});

test("the scroll box is near the bottom only within the threshold", () => {
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 420, clientHeight: 500 }), true);
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 419, clientHeight: 500 }), false);
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 }, 0), true);
  assert.equal(isNearBottom({}, 80), true);
});
