import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, rmSync } from "node:fs";
import { addRoute } from "./server.mjs";
import { log } from "./utils.mjs";
import { appPath, dataPath } from "./paths.mjs";

const CONFIG_PATH = dataPath("config.json");
const EXAMPLE_CONFIG_PATH = appPath("config.example.json");

const CONFIG_FIELDS = {
  "paths.npmGlobal": "string",
  "paths.claude": "string",
  "paths.codex": "string",
  "paths.ragScript": "string",
  "paths.workDir": "string",
  "proxy.https": "string",
  "proxy.claudeHttps": "string",
  "proxy.codexHttps": "string",
  "proxy.ragHttps": "string",
  "models.claudeFast": "string",
  "models.claudeFallback": "string",
  "timeouts.aiMs": "number",
  "vision.mode": "string",
  "vision.baseUrl": "string",
  "vision.apiKey": "string",
  "vision.model": "string",
  "vision.detail": "string",
  "vision.timeoutMs": "number",
  "chat.baseUrl": "string",
  "chat.apiKey": "string",
  "chat.model": "string",
  "chat.temperature": "number",
  "chat.maxTokens": "number",
  "chat.timeoutMs": "number",
  "chat.compactKeepTurns": "number",
  "chat.compactTimeoutMs": "number",
  "chat.compactMaxTokens": "number",
  "chat.compactMessageMaxChars": "number",
  "rag.enabled": "boolean",
  "rag.knowledgeDir": "string",
  "rag.storeDir": "string",
  "rag.modelCacheDir": "string",
  "rag.collectionName": "string",
  "rag.embedModel": "string",
  "rag.topK": "number",
  "rag.minScore": "number",
  "rag.scoreMargin": "number",
  "rag.chunkMaxChars": "number",
  "rag.resultMaxChars": "number",
  "rag.batchSize": "number",
  "logs.retentionDays": "number",
};

function readJsonFile(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function loadConfigForGui() {
  return readJsonFile(CONFIG_PATH) || readJsonFile(EXAMPLE_CONFIG_PATH) || {};
}

function getNested(obj, key) {
  let cur = obj;
  for (const part of key.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function setNested(obj, key, value) {
  const parts = key.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = cur[parts[i]] && typeof cur[parts[i]] === "object" ? cur[parts[i]] : {};
    cur = cur[parts[i]];
  }
  cur[parts.at(-1)] = value;
}

function coerceConfigValue(value, type, currentValue) {
  if (type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) return currentValue ?? 0;
    return n;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    return !/^(0|false|no|off)$/i.test(String(value).trim());
  }
  return String(value ?? "");
}

function sanitizeConfigBody(body, current) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("config body must be an object");
  }
  const next = structuredClone(current || {});
  for (const [key, type] of Object.entries(CONFIG_FIELDS)) {
    let value = getNested(body, key);
    if (value === undefined) continue;
    if ((key === "vision.apiKey" || key === "chat.apiKey") && String(value).includes("****")) {
      value = getNested(current, key) || "";
    }
    setNested(next, key, coerceConfigValue(value, type, getNested(current, key)));
  }
  return next;
}

function writeConfigAtomic(config) {
  const tmpPath = `${CONFIG_PATH}.tmp`;
  const backupPath = `${CONFIG_PATH}.backup`;
  if (existsSync(CONFIG_PATH)) copyFileSync(CONFIG_PATH, backupPath);
  try {
    writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    renameSync(tmpPath, CONFIG_PATH);
  } catch (e) {
    try { rmSync(tmpPath, { force: true }); } catch {}
    throw e;
  }
}

export function registerConfigRoutes() {
  addRoute("GET", "/api/config", () => {
    try {
      const raw = loadConfigForGui();
      if (raw.vision?.apiKey) {
        raw.vision.apiKey = raw.vision.apiKey.slice(0, 8) + "****";
      }
      if (raw.chat?.apiKey) {
        raw.chat.apiKey = raw.chat.apiKey.slice(0, 8) + "****";
      }
      return { ok: true, config: raw };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  addRoute("POST", "/api/config", ({ body }) => {
    try {
      const current = loadConfigForGui();
      const next = sanitizeConfigBody(body, current);
      writeConfigAtomic(next);
      log("\u{2699}", "config.json updated (backup saved)");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}
