import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createStaticServer, resolveStaticPath } from "../scripts/serve.mjs";

const PUBLIC = fileURLToPath(new URL("../public", import.meta.url));

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

  const missing = await fetch(`${base}/nope.js`);
  assert.equal(missing.status, 404);
  const traversal = await fetch(`${base}/%2e%2e/package.json`);
  assert.equal(traversal.status, 404);
  const post = await fetch(`${base}/`, { method: "POST" });
  assert.equal(post.status, 405);
});
