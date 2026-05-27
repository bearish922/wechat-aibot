import crypto from "node:crypto";

export function uuid() { return crypto.randomUUID(); }
export function shortId() { return crypto.randomUUID().slice(0, 8); }
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function log(emoji, msg) {
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  process.stdout.write(`[${ts}] ${emoji} ${msg}\n`);
}

export function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
