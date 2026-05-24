import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { exec } from "node:child_process";
import { log } from "./utils.mjs";
import { configValue } from "./config.mjs";

const STATIC_DIR = join(import.meta.dirname, "..", "static");
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

function serveStatic(urlPath, res) {
  let filePath = urlPath === "/" ? "/index.html" : urlPath;
  const fullPath = join(STATIC_DIR, filePath);
  if (!existsSync(fullPath)) return false;
  try {
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
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { resolve(body); }
    });
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
      if (route.method === method && route.path === url) {
        try {
          const body = method === "GET" ? null : await readBody(req);
          const result = await route.handler({ req, res, body, json: (d, s) => json(res, d, s) });
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
