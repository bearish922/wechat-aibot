import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, resolve, relative, sep } from "node:path";
import { exec } from "node:child_process";
import { log } from "./utils.mjs";
import { configValue } from "./config.mjs";

const STATIC_DIR = resolve(import.meta.dirname, "..", "static");
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
    if (!isInsideStaticDir(fullPath) || !existsSync(fullPath) || !statSync(fullPath).isFile()) return false;

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
    let body = "";
    let tooLarge = false;
    req.on("data", (c) => {
      if (tooLarge) return;
      body += c;
      if (body.length > 1024 * 1024) {
        tooLarge = true;
        reject(new Error("request body too large"));
      }
    });
    req.on("end", () => {
      if (tooLarge) return;
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

    // API routes first
    for (const route of routes) {
      const params = route.method === method ? matchRoute(route.path, url) : null;
      if (params) {
        try {
          const body = method === "GET" ? null : await readBody(req);
          const result = await route.handler({ req, res, body, params, json: (d, s) => json(res, d, s) });
          if (result !== undefined) json(res, result);
        } catch (e) {
          json(res, { ok: false, error: e.message }, 500);
        }
        return;
      }
    }

    // Static files
    if (method === "GET" && serveStatic(url, res)) return;

    // 404
    json(res, { ok: false, error: "not found" }, 404);
  });

  server.on("error", (e) => {
    log("❌", `GUI server failed: ${e.message}`);
    process.exitCode = 1;
    try { server.close(); } catch {}
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", () => {
    log("\u{1F310}", `GUI: http://127.0.0.1:${port}`);
    exec(`cmd /c start http://127.0.0.1:${port}`, { windowsHide: true });
  });
}

export function stopServer() {
  if (server) {
    server.close();
    server = null;
  }
}
