import assert from "node:assert/strict";
import test from "node:test";

import { extractThinking, renderMarkdown } from "../public/markdown.js";

test("raw HTML is escaped before anything else", () => {
  const html = renderMarkdown("<script>alert(1)</script>");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
});

test("inline code and fenced code are escaped once", () => {
  assert.equal(renderMarkdown("Use `<tag>` here."), "<p>Use <code>&lt;tag&gt;</code> here.</p>");
  const fenced = renderMarkdown("```js\nconst x = '<b>';\n```");
  assert.ok(fenced.includes("<pre>"));
  assert.ok(fenced.includes("const x = &#39;&lt;b&gt;&#39;;"));
  assert.ok(fenced.includes("js"), "language label is shown");
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
  assert.ok(html.startsWith("<pre>"));
  assert.ok(html.includes("const answer = 42;"));
});

test("tables, strikethrough, task lists, rules and bare links render", () => {
  const table = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
  assert.ok(table.includes("<table>") && table.includes("<th>a</th>"));
  assert.ok(renderMarkdown("~~gone~~").includes("<del>gone</del>"));
  const tasks = renderMarkdown("- [x] done\n- [ ] todo");
  assert.ok(tasks.includes('type="checkbox"') && tasks.includes("todo"));
  assert.ok(renderMarkdown("---").includes("<hr>"));
  // hygiene: allow test example URL
  assert.ok(renderMarkdown("see https://example.test/x").includes('<a href="https://example.test/x"'));
});

test("think blocks are extracted and never rendered inline", () => {
  const split = extractThinking("<think>plan first</think>\nFinal answer");
  assert.equal(split.thinking, "plan first");
  assert.equal(split.visible, "Final answer");
  const html = renderMarkdown("<think>secret plan</think>\nVisible");
  assert.ok(!html.includes("secret plan"));
  assert.ok(html.includes("Visible"));
});

test("NUL placeholder sequences never resolve to code spans", () => {
  const nul = String.fromCharCode(0);
  const html = renderMarkdown(`${nul}0${nul}`);
  assert.ok(!html.includes("undefined"));
  assert.ok(!html.includes("<code>"));
});

test("a fenced block closes only on a bare fence", () => {
  const html = renderMarkdown("```\ncode\n```js\nmore");
  assert.ok(!html.includes("<p>more</p>"), "```js must not close the fence");
  assert.ok(html.includes("more"), "trailing text stays inside the fence");
});

test("table alignment uses CSP-safe attributes, never inline styles", () => {
  const html = renderMarkdown("| a | b |\n| :---: | ---: |\n| 1 | 2 |");
  assert.ok(html.includes('data-align="center"'), "center alignment survives");
  assert.ok(html.includes('data-align="right"'), "right alignment survives");
  assert.ok(!html.includes("style="), "no inline style for the shipped style-src 'self' CSP");
});
