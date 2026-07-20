import fs from "node:fs";
import crypto from "node:crypto";
import { token, getUpdatesBuf, activeAI, setToken, setSyncBuf, setActiveAI } from "./state.mjs";
import { sleep, log, shortId } from "./utils.mjs";
import { DATA_DIR, dataPath, ensureDir } from "./paths.mjs";

// 微信 AI 平台 API 基础地址
const BASE_URL = "https://ilinkai.weixin.qq.com";
// 微信 CDN 图片上传地址
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
// 机器人类型标识
const BOT_TYPE = "3";
// 长轮询超时时间(毫秒)
const LONG_POLL_TIMEOUT_MS = 35_000;
// token 持久化文件路径
const TOKEN_FILE = dataPath("wechat-token.json");

// ─── HTTP helpers ───────────────────────────────────────────
// 生成随机的 X-WECHAT-UIN 标识(基于 4 字节随机数转 base64)
function randomUin() {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0))).toString("base64");
}
// API 客户端版本号编码: major.minor.patch 各占 8 位
const VERSION_CODE = ((1 & 0xff) << 16) | ((0 & 0xff) << 8) | (0 & 0xff);

// 构建通用请求头(不含 Authorization)
function commonHeaders() {
  return { "iLink-App-Id": "bot", "iLink-App-ClientVersion": String(VERSION_CODE) };
}

// 构建 API 请求头(含 Content-Type、Authorization、随机 UIN)
function apiHeaders() {
  const h = { ...commonHeaders(), "Content-Type": "application/json", "AuthorizationType": "ilink_bot_token", "X-WECHAT-UIN": randomUin() };
  // 已登录时附加 Bearer token
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// 向微信 AI 平台发送 POST 请求，支持超时控制
// 参数: endpoint - API 端点路径; bodyObj - 请求体对象; timeoutMs - 超时毫秒(默认15s)
// 返回: 解析后的 JSON 响应对象
export async function apiPost(endpoint, bodyObj = {}, timeoutMs = 15_000) {
  const ctrl = new AbortController();
  // 设置超时定时器
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/${endpoint}`, { method: "POST", headers: apiHeaders(), body: JSON.stringify(bodyObj), signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`WeChat HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  } catch (e) {
    // AbortError 时返回超时错误码而非抛出
    if (e.name === "AbortError") return { ret: -1, errmsg: "timeout" };
    throw e;
  } finally { clearTimeout(t); }
}

// 向微信 AI 平台发送 GET 请求(用于轮询等长连接场景)
// 参数: endpoint - API 端点; timeoutMs - 超时(默认15s); baseUrl - 可覆盖基础 URL
// 返回: 解析后的 JSON 响应；网络错误时返回 { status: "wait" }
export async function apiGet(endpoint, timeoutMs = 15_000, baseUrl = BASE_URL) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/${endpoint}`, { method: "GET", headers: commonHeaders(), signal: ctrl.signal });
    if (!res.ok) return { status: "wait" };
    return await res.json();
  } catch (e) {
    // GET 请求失败(含超时)统一返回 wait 状态使轮询继续
    if (e.name === "AbortError") return { status: "wait" };
    return { status: "wait" };
  } finally { clearTimeout(t); }
}

// ─── Token ──────────────────────────────────────────────────
// 从文件加载持久化的 token、同步缓冲区和上次使用的 AI 后端
// 返回: true 加载成功，false 文件不存在或解析失败
export function loadToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const d = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
      // 恢复 token 到全局状态
      setToken(d.token);
      // 恢复消息同步缓冲区
      setSyncBuf(d.syncBuf || "");
      // 恢复上次使用的 AI 后端
      if (d.lastActiveAI === "cc" || d.lastActiveAI === "codex" || d.lastActiveAI === "api") setActiveAI(d.lastActiveAI);
      if (token) log("📂", "已加载 token");
      return true;
    }
  } catch { /* 忽略文件读取或 JSON 解析错误 */ }
  return false;
}

// 将当前 token、同步缓冲区和 AI 后端持久化到文件
// 参数: syncBuf - 同步缓冲区(默认取全局 getUpdatesBuf 函数返回的值)
export function saveToken(syncBuf = getUpdatesBuf) {
  ensureDir(DATA_DIR);
  const tmp = `${TOKEN_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ token, syncBuf, lastActiveAI: activeAI }, null, 2), "utf-8");
    fs.renameSync(tmp, TOKEN_FILE);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

// ─── QR login ───────────────────────────────────────────────
// 尝试在终端输出二维码(需要 qrcode-terminal 包)，失败则静默
// 参数: qrcodeUrl - 二维码链接
// 返回: true 终端输出成功，false 包不可用
async function tryQrTerminal(qrcodeUrl) {
  try { const { default: qr } = await import("qrcode-terminal"); qr.generate(qrcodeUrl, { small: true }); return true; }
  catch { return false; }
}

// 通过微信扫码登录获取 bot_token，支持长轮询等待用户确认
// 轮询状态: wait(等待扫码) -> scaned(已扫码) -> confirmed(已确认) -> 获取 token
// 二维码过期自动重新获取，8 分钟超时
export async function loginWithQr() {
  log("🔑", "获取二维码...");
  // 向微信平台请求生成登录二维码
  const qrResp = await apiPost(`ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`, { local_token_list: [] });
  if (!qrResp.qrcode_img_content) { log("❌", "获取二维码失败: " + JSON.stringify(qrResp)); process.exit(1); }

  const qrcodeUrl = qrResp.qrcode_img_content;
  const qrcode = qrResp.qrcode;
  // 尝试在终端输出二维码图像
  const qrOk = await tryQrTerminal(qrcodeUrl);
  // 终端无法输出时打印二维码链接作为备选
  if (!qrOk) log("🔗", "二维码链接: " + qrcodeUrl);
  log("📱", "请用手机微信扫描二维码...");

  // 轮询基础 URL(可能因 redirect 被覆盖)
  let pollBaseUrl = BASE_URL;
  // 8 分钟超时
  const deadline = Date.now() + 480_000;
  while (Date.now() < deadline) {
    let sr;
    // 长轮询查询二维码状态
    try { sr = await apiGet(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, LONG_POLL_TIMEOUT_MS, pollBaseUrl); }
    catch { await sleep(1000); continue; }

    switch (sr.status) {
      // 等待扫码
      case "wait": break;
      // 已扫码待确认
      case "scaned": log("📱", "已扫码，请在手机上确认..."); break;
      // 需要重定向到其他服务器
      case "scaned_but_redirect": if (sr.redirect_host) { pollBaseUrl = `https://${sr.redirect_host}`; log("🔀", "重定向: " + pollBaseUrl); } break;
      // 确认登录成功: 保存 token 并退出轮询
      case "confirmed": setToken(sr.bot_token); saveToken(""); log("✅", "登录成功! bot_id=" + sr.ilink_bot_id); return;
      // 二维码过期: 递归重新获取
      case "expired": log("⏰", "二维码过期，重新获取..."); return loginWithQr();
      // 已连接过此设备(无需重新登录)
      case "binded_redirect": log("✅", "已连接过此设备"); process.exit(0);
      default: log("⚠️", "未知状态: " + sr.status);
    }
    await sleep(1000);
  }
  // 超时退出
  log("❌", "登录超时"); process.exit(1);
}

// ─── Send ───────────────────────────────────────────────────
// 向指定微信用户发送文本消息，支持最多 3 次重试
// 参数: toUserId - 目标用户的微信 openid; text - 消息文本; contextToken - 上下文 token
// 返回: true 发送成功，false 3 次重试后仍失败
export async function sendMessage(toUserId, text, contextToken) {
  // 空文本直接返回成功(不发送空消息)
  if (!text?.trim()) return true;
  // 同一条逻辑消息的重试必须复用 client_id，避免“服务端已收到但响应丢失”时重复发送。
  const clientId = shortId();
  // 最多 3 次尝试
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await apiPost("ilink/bot/sendmessage", {
        msg: { to_user_id: toUserId, client_id: clientId, message_type: 2, message_state: 2,
          // 消息类型 type=1 表示文本消息
          item_list: [{ type: 1, text_item: { text } }], context_token: contextToken || undefined },
      });
      // 检查微信平台返回的业务错误码
      if (resp?.ret && resp.ret !== 0) throw new Error(resp.errmsg || `ret=${resp.ret}`);
      if (resp?.errcode && resp.errcode !== 0) throw new Error(resp.errmsg || `errcode=${resp.errcode}`);
      return true;
    } catch (e) {
      const triesLeft = attempt < 2;
      log(triesLeft ? "⚠️" : "❌", `发送失败${triesLeft ? "，重试中" : ""}: ${e.message}`);
      // 还有重试机会时，按指数退避等待(800ms, 1600ms)
      if (triesLeft) await sleep(800 * (attempt + 1));
    }
  }
  return false;
}
