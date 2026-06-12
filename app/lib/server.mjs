import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, resolve, relative, sep } from "node:path";
import { exec } from "node:child_process";
import { log } from "./utils.mjs";
import { appPath } from "./paths.mjs";

const STATIC_DIR = appPath("static");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const routes = [];

export function addRoute(method, path, handler) {
  routes.push({ method, path, handler });
}

function matchRoute(pattern, urlPath) {
  if (pattern === urlPath) return {};
  const patternParts = pattern.split("/").filter(Boolean);
  const urlParts = urlPath.split("/").filter(Boolean);
  if (patternParts.length !== urlParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i];
    const urlPart = urlParts[i];
    if (patternPart.startsWith(":")) {
      try {
        params[patternPart.slice(1)] = decodeURIComponent(urlPart);
      } catch {
        return null;
      }
      continue;
    }
    if (patternPart !== urlPart) return null;
  }
  return params;
}

function isInsideStaticDir(filePath) {
  const rel = relative(STATIC_DIR, filePath);
  return rel === "" || (rel && !rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function serveStatic(urlPath, res) {
  try {
    const decoded = decodeURIComponent(urlPath.split("?")[0]);
    if (decoded.includes("\0")) return false;
    const relPath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    const fullPath = resolve(STATIC_DIR, relPath);
    if (!isInsideStaticDir(fullPath)) return false;
    try { if (!statSync(fullPath).isFile()) return false; } catch { return false; }

    const ext = extname(fullPath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(readFileSync(fullPath));
    return true;
  } catch {
    return false;
  }
}

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const LIMIT = 1024 * 1024;
    req.on("data", (c) => {
      if (size > LIMIT) return;
      chunks.push(c);
      size += c.length;
      if (size > LIMIT) reject(new Error("request body too large"));
    });
    req.on("end", () => {
      if (size > LIMIT) return;
      const body = Buffer.concat(chunks).toString();
      try { resolve(JSON.parse(body)); } catch { resolve(body); }
    });
    req.on("error", reject);
  });
}

let server = null;

export function startServer(port = 18720) {
  if (server) return;
  server = createServer(async (req, res) => {
    const url = req.url.split("?")[0];
    const method = req.method.toUpperCase();

    // 优先匹配 API 路由（动态路由优先于静态文件）
    for (const route of routes) {
      const params = route.method === method ? matchRoute(route.path, url) : null;
      if (params) {
        try {
          const body = method === "GET" ? null : await readBody(req);
          const result = await route.handler({ req, res, body, params, json: (d, s) => json(res, d, s) });
          // Route handlers may return { status } so callers receive the intended HTTP status,
          // not a misleading 200 response containing an error body.
          if (result !== undefined) json(res, result, Number(result?.status) || 200);
        } catch (e) {
          json(res, { ok: false, error: e.message }, 500);
        }
        return;
      }
    }

    // 其次尝试匹配静态文件（如 HTML/CSS/JS）
    if (method === "GET" && serveStatic(url, res)) return;

    // 404
    json(res, { ok: false, error: "not found" }, 404);
  });

  server.on("error", (e) => {
    log("❌", `GUI server failed: ${e.message}`);
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", () => {
    log("\u{1F310}", `GUI: http://127.0.0.1:${port}`);
    const url = `http://127.0.0.1:${port}`;
    setTimeout(() => {
      exec(`start "" "${url}"`, { shell: "cmd.exe", windowsHide: true }, (err) => {
        if (err) log("⚠", `GUI open failed: ${err.message}`);
      });
    }, 600);
  });
}

export function stopServer() {
  if (server) {
    server.close();
    server = null;
  }
}
