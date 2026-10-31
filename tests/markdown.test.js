import assert from "node:assert/strict";
import test from "node:test";

import { renderMarkdown } from "../public/markdown.js";

test("raw HTML is escaped before anything else", () => {
  const html = renderMarkdown("<script>alert(1)</script>");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
});

test("inline code and fenced code are escaped once", () => {
  assert.equal(renderMarkdown("Use `<tag>` here."), "<p>Use <code>&lt;tag&gt;</code> here.</p>");
  const fenced = renderMarkdown("```js\nconst x = '<b>';\n```");
  assert.ok(fenced.includes("<pre><code>const x = &#39;&lt;b&gt;&#39;;</code></pre>"));
  assert.ok(!fenced.includes("<b>"));
});

test("only http and https links become links", () => {
  // hygiene: allow test example URL
  const safe = renderMarkdown("[docs](https://example.test/a?b=1)");
  // hygiene: allow test example URL
  assert.ok(safe.includes('<a href="https://example.test/a?b=1"'));
  const unsafe = renderMarkdown("[click](javascript:alert(1))");
  assert.ok(!unsafe.includes("<a "));
});

test("headings, bold, lists and quotes render", () => {
  const html = renderMarkdown("## Title\n\n**bold**\n\n- one\n- two\n\n> quote");
  assert.ok(html.includes("<h2>Title</h2>"));
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<ul><li>one</li><li>two</li></ul>"));
  assert.ok(html.includes("<blockquote>quote</blockquote>"));
});

test("an unfinished code fence still renders while streaming", () => {
  const html = renderMarkdown("```js\nconst answer = 42;");
  assert.ok(html.startsWith("<pre><code>"));
  assert.ok(html.includes("const answer = 42;"));
});
