import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A tiny static server for ChatDuck. It serves `public/` on loopback only and
 * refuses paths outside that folder, so `npm start` needs no dependency and no
 * build step.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, "..", "public");
const DEFAULT_PORT = 4173;

const MIME = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
});

const HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'self'; connect-src http: https:; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

/** The command that opens a URL in the default browser. */
export function browserOpenCommand(platform, url) {
  if (platform === "win32") return { command: "cmd.exe", args: ["/c", "start", "", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

function openBrowser(url) {
  const { command, args } = browserOpenCommand(process.platform, url);
  execFile(command, args, (error) => {
    if (error) process.stderr.write(`[chatduck] Could not open the browser: ${error.message}\n`);
  });
}

/** The file inside `root` for a URL path, or null when it would leave the folder. */
export function resolveStaticPath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const base = path.resolve(root);
  const file = path.resolve(base, relative);
  return file === base || file.startsWith(`${base}${path.sep}`) ? file : null;
}

export function createStaticServer({ root = PUBLIC_DIR } = {}) {
  return http.createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
      response.end("Method not allowed");
      return;
    }
    const pathname = (request.url ?? "/").split("?")[0];
    const file = resolveStaticPath(root, pathname);
    if (!file) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    let body;
    try {
      body = await readFile(file);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      ...HEADERS,
      "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const open = process.argv.includes("--open");
  const server = createStaticServer();
  server.on("error", (error) => {
    process.stderr.write(
      error.code === "EADDRINUSE"
        ? `[chatduck] Port ${port} is already in use. Close the other server or set PORT.\n`
        : `[chatduck] ${error.message}\n`,
    );
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}`;
    process.stdout.write(`ChatDuck on ${url}\n`);
    if (open) openBrowser(url);
  });
}
