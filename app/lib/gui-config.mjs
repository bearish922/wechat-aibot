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
  "paths.profileClaudeConfigDirs": "object",
  "proxy.https": "string",
  "proxy.claudeHttps": "string",
  "proxy.codexHttps": "string",
  "proxy.ragHttps": "string",
  "api.baseUrl": "string",
  "api.apiKey": "string",
  "api.model": "string",
  "models.claudeMain": "string",
  "models.claudeFast": "string",
  "models.claudeFallback": "string",
  "models.codexMain": "string",
  "models.codexReasoningEffort": "string",
  "models.claudeContextMax": "number",
  "models.codexContextMax": "number",
  "timeouts.aiMs": "number",
  "scene.sceneletBare": "boolean",
  "vision.mode": "string",
  "vision.baseUrl": "string",
  "vision.apiKey": "string",
  "vision.model": "string",
  "vision.detail": "string",
  "vision.timeoutMs": "number",
  "voice.enabled": "boolean",
  "voice.whisperxPython": "string",
  "voice.model": "string",
  "voice.language": "string",
  "voice.computeType": "string",
  "voice.batchSize": "number",
  "voice.sampleRate": "number",
  "voice.noAlign": "boolean",
  "voice.timeoutMs": "number",
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
  "rag.rerankLimit": "number",
  "rag.includeDirs": "string",
  "rag.excludeDirs": "string",
  "rag.excludeFiles": "string",
  "logs.retentionDays": "number",
  "send.chunkSendDelayMs": "number",
  "send.maxCancelReasonLength": "number",
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
  if (type === "object") {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(String(value || "{}"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : (currentValue ?? {});
    } catch {
      return currentValue ?? {};
    }
  }
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

export function sanitizeConfigBody(body, current) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("config body must be an object");
  }
  const next = structuredClone(current || {});
  for (const [key, type] of Object.entries(CONFIG_FIELDS)) {
    let value = getNested(body, key);
    if (value === undefined) continue;
    if ((key === "vision.apiKey" || key === "api.apiKey") && String(value).includes("****")) {
      value = getNested(current, key) || "";
    }
    setNested(next, key, coerceConfigValue(value, type, getNested(current, key)));
  }
  return next;
}

export function maskConfigSecrets(config) {
  const masked = structuredClone(config || {});
  for (const key of ["api.apiKey", "vision.apiKey"]) {
    const value = getNested(masked, key);
    if (value) setNested(masked, key, String(value).slice(0, 8) + "****");
  }
  return masked;
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
      return { ok: true, config: maskConfigSecrets(loadConfigForGui()) };
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
