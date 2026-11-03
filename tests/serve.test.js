import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { browserOpenCommand, createStaticServer, resolveStaticPath } from "../scripts/serve.mjs";

const PUBLIC = fileURLToPath(new URL("../public", import.meta.url));

test("the open flag uses the platform browser command", () => {
  assert.deepEqual(browserOpenCommand("win32", "http://127.0.0.1:4173"), {
    command: "cmd.exe",
    args: ["/c", "start", "", "http://127.0.0.1:4173"],
  });
  assert.deepEqual(browserOpenCommand("darwin", "http://127.0.0.1:4173"), {
    command: "open",
    args: ["http://127.0.0.1:4173"],
  });
  assert.deepEqual(browserOpenCommand("linux", "http://127.0.0.1:4173"), {
    command: "xdg-open",
    args: ["http://127.0.0.1:4173"],
  });
});

test("the static path never leaves the public folder", () => {
  assert.ok(resolveStaticPath(PUBLIC, "/").endsWith("index.html"));
  assert.ok(resolveStaticPath(PUBLIC, "/app.js").endsWith("app.js"));
  assert.equal(resolveStaticPath(PUBLIC, "/%2e%2e/package.json"), null);
  assert.equal(resolveStaticPath(PUBLIC, "/../package.json"), null);
});

test("the static server serves the app and refuses other methods", async (t) => {
  const server = createStaticServer({ root: PUBLIC });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /ChatDuck/);
  assert.match(index.headers.get("content-type"), /text\/html/);
  assert.match(index.headers.get("content-security-policy"), /connect-src/);

  const script = await fetch(`${base}/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);

  const manifest = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get("content-type"), /manifest/);

  const missing = await fetch(`${base}/nope.js`);
  assert.equal(missing.status, 404);
  const traversal = await fetch(`${base}/%2e%2e/package.json`);
  assert.equal(traversal.status, 404);
  const post = await fetch(`${base}/`, { method: "POST" });
  assert.equal(post.status, 405);
});

test("error responses keep security headers and HEAD sends no body", async (t) => {
  const server = createStaticServer({ root: PUBLIC });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const missing = await fetch(`${base}/nope.js`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get("content-security-policy") ?? "", /default-src/);
  assert.equal(missing.headers.get("x-content-type-options"), "nosniff");

  const post = await fetch(`${base}/`, { method: "POST" });
  assert.equal(post.status, 405);
  assert.match(post.headers.get("content-security-policy") ?? "", /default-src/);
});
