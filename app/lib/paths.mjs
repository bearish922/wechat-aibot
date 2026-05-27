import fs from "node:fs";
import path from "node:path";

export const APP_DIR = path.resolve(import.meta.dirname, "..");
export const PROJECT_ROOT = path.resolve(APP_DIR, "..");
export const DATA_DIR = path.join(PROJECT_ROOT, "data");
export const RUNTIME_DIR = path.join(DATA_DIR, "runtime");

export function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function rootPath(...parts) {
  return path.join(PROJECT_ROOT, ...parts);
}

export function appPath(...parts) {
  return path.join(APP_DIR, ...parts);
}

export function dataPath(...parts) {
  return path.join(DATA_DIR, ...parts);
}

export function resolveProjectPath(value, fallbackParts = []) {
  const target = value || path.join(...fallbackParts);
  return path.isAbsolute(String(target)) ? String(target) : path.join(PROJECT_ROOT, String(target));
}
