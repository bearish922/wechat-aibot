import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { token, getUpdatesBuf, activeAI, setToken, setSyncBuf, setActiveAI } from "./state.mjs";
import { sleep, log, shortId } from "./utils.mjs";

const BASE_URL = "https://ilinkai.weixin.qq.com";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const BOT_TYPE = "3";
const LONG_POLL_TIMEOUT_MS = 35_000;
const TOKEN_FILE = path.join(import.meta.dirname, "..", "wechat-token.json");

// ─── HTTP helpers ───────────────────────────────────────────
function randomUin() {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0))).toString("base64");
}
const VERSION_CODE = ((1 & 0xff) << 16) | ((0 & 0xff) << 8) | (0 & 0xff);

function commonHeaders() {
  return { "iLink-App-Id": "bot", "iLink-App-ClientVersion": String(VERSION_CODE) };
}

function apiHeaders() {
  const h = { ...commonHeaders(), "Content-Type": "application/json", "AuthorizationType": "ilink_bot_token", "X-WECHAT-UIN": randomUin() };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export async function apiPost(endpoint, bodyObj = {}, timeoutMs = 15_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/${endpoint}`, { method: "POST", headers: apiHeaders(), body: JSON.stringify(bodyObj), signal: ctrl.signal });
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") return { ret: -1, errmsg: "timeout" };
    throw e;
  } finally { clearTimeout(t); }
}

export async function apiGet(endpoint, timeoutMs = 15_000, baseUrl = BASE_URL) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/${endpoint}`, { method: "GET", headers: commonHeaders(), signal: ctrl.signal });
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") return { status: "wait" };
    return { status: "wait" };
  } finally { clearTimeout(t); }
}

// ─── Token ──────────────────────────────────────────────────
export function loadToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const d = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
      setToken(d.token);
      setSyncBuf(d.syncBuf || "");
      if (d.lastActiveAI === "cc" || d.lastActiveAI === "codex") setActiveAI(d.lastActiveAI);
      if (token) log("\u{1F4C2}", "已加载 token");
      return true;
    }
  } catch { /* ignore */ }
  return false;
}
export function saveToken(syncBuf = getUpdatesBuf) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, syncBuf, lastActiveAI: activeAI }, null, 2));
}

// ─── QR login ───────────────────────────────────────────────
async function tryQrTerminal(qrcodeUrl) {
  try { const { default: qr } = await import("qrcode-terminal"); qr.generate(qrcodeUrl, { small: true }); return true; }
  catch { return false; }
}

export async function loginWithQr() {
  log("\u{1F511}", "获取二维码...");
  const qrResp = await apiPost(`ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`, { local_token_list: [] });
  if (!qrResp.qrcode_img_content) { log("❌", "获取二维码失败: " + JSON.stringify(qrResp)); process.exit(1); }

  const qrcodeUrl = qrResp.qrcode_img_content;
  const qrcode = qrResp.qrcode;
  const qrOk = await tryQrTerminal(qrcodeUrl);
  if (!qrOk) log("\u{1F517}", "二维码链接: " + qrcodeUrl);
  log("\u{1F4F1}", "请用手机微信扫描二维码...");

  let pollBaseUrl = BASE_URL;
  const deadline = Date.now() + 480_000;
  while (Date.now() < deadline) {
    let sr;
    try { sr = await apiGet(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, LONG_POLL_TIMEOUT_MS, pollBaseUrl); }
    catch { await sleep(1000); continue; }

    switch (sr.status) {
      case "wait": break;
      case "scaned": log("\u{1F4F1}", "已扫码，请在手机上确认..."); break;
      case "scaned_but_redirect": if (sr.redirect_host) { pollBaseUrl = `https://${sr.redirect_host}`; log("\u{1F504}", "重定向: " + pollBaseUrl); } break;
      case "confirmed": setToken(sr.bot_token); saveToken(""); log("✅", "登录成功! bot_id=" + sr.ilink_bot_id); return;
      case "expired": log("⏰", "二维码过期，重新获取..."); return loginWithQr();
      case "binded_redirect": log("✅", "已连接过此设备"); process.exit(0);
      default: log("⚠️", "未知状态: " + sr.status);
    }
    await sleep(1000);
  }
  log("❌", "登录超时"); process.exit(1);
}

// ─── Send ───────────────────────────────────────────────────
export async function sendMessage(toUserId, text, contextToken) {
  if (!text?.trim()) return;
  try {
    await apiPost("ilink/bot/sendmessage", {
      msg: { to_user_id: toUserId, client_id: shortId(), message_type: 2, message_state: 2,
        item_list: [{ type: 1, text_item: { text } }], context_token: contextToken || undefined },
    });
  } catch (e) { log("❌", `发送失败: ${e.message}`); }
}
