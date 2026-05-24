import fs from "node:fs";
import path from "node:path";

const CONFIG_FILE = path.join(import.meta.dirname, "..", "config.json");

function loadAppConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch (e) {
    process.stderr.write(`Failed to load config.json: ${e.message}\n`);
    return {};
  }
}

const APP_CONFIG = loadAppConfig();

export function configValue(key, fallback = null) {
  let cur = APP_CONFIG;
  for (const part of key.split(".")) {
    if (!cur || typeof cur !== "object" || !(part in cur)) return fallback;
    cur = cur[part];
  }
  return cur ?? fallback;
}

export function envOrConfig(envName, configKey, fallback = null) {
  return process.env[envName] !== undefined ? process.env[envName] : configValue(configKey, fallback);
}

export function configBool(key, fallback = false) {
  const value = configValue(key, fallback);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return !/^(0|false|no|off)$/i.test(value.trim());
  return Boolean(value);
}

export function configNumber(key, fallback) {
  const n = Number(configValue(key, fallback));
  return Number.isFinite(n) ? n : fallback;
}
