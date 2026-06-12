// reply.mjs — prompt 配置加载 + 回复文本拆分/格式化
// 负责从 data/prompts.json 读取运行时配置，以及消息拆分、时间格式化等工具函数

import { readFileSync } from "node:fs";
import { rootPath } from "./paths.mjs";
import { mergeRolePrompts } from "./role-prompts.mjs";
export { getWeatherReality, formatWeatherReality } from "./weather.mjs";

// 运行时 prompt 配置文件路径
const PROMPTS_FILE = rootPath("data/prompts.json");

import {
  DEFAULT_VISION_CAPTION_PROMPT,
  DEFAULT_SEASONAL_MONTHLY_NOTES,
  DEFAULT_VISIBLE_CONTEXT_TURNS,
  DEFAULT_PROACTIVE_CHECK_INTERVAL_MS,
  DEFAULT_PROACTIVE_COOLDOWN_MS,
  DEFAULT_PROACTIVE_DAILY_MAX,
  DEFAULT_DAILY_SHARE_SEED_INTERVAL_MS,
  DEFAULT_DAILY_SHARE_MIN_IDLE_MS,
  DEFAULT_PROACTIVE_DEFAULT_EXPIRY_OFFSET_MS,
  DEFAULT_DAILY_SHARE_DEFAULT_SCHEDULE_OFFSET_MS,
  DEFAULT_DAILY_SHARE_DEFAULT_EXPIRY_OFFSET_MS,
  DEFAULT_DAILY_SHARE_DEFAULT_CANCEL_IF,
  DEFAULT_RAG_TOP_K,
  DEFAULT_RAG_MIN_SCORE,
  DEFAULT_RAG_RESULT_MAX_CHARS,
  DEFAULT_RAG_TIMEOUT_MS,
  DEFAULT_SCHEDULE_CHECK_INTERVAL_MS,
  DEFAULT_SCHEDULE_FINALIZATION_TIMEOUT_MS,
  DEFAULT_SCHEDULE_RECENT_KINDS_LIMIT,
  DEFAULT_SCHEDULE_BASIS_MAX_LENGTH,
  DEFAULT_SCHEDULE_ARC_TITLE_MAX_LENGTH,
  DEFAULT_SCHEDULE_EXPIRY_AFTER_END_BUFFER_MS,
  DEFAULT_SCHEDULE_DEFAULT_EXPIRY_FROM_NOW_MS,
  DEFAULT_HIDDEN_WORLD_MAX_PENDING_INTENTS,
  DEFAULT_CHUNK_SEND_DELAY_MS,
  DEFAULT_MAX_CANCEL_REASON_LENGTH,
  DEFAULT_TURN_RESET_THRESHOLD,
  DEFAULT_STATE_STALE_THRESHOLD_MS,
  normalizeRagKeywords,
} from "./default-prompts.mjs";

// 从 data/prompts.json 加载运行时配置。角色文本由 role-prompts.mjs 提供完整基线，
// 全局参数在文件缺失或解析失败时退回到本模块导入的 DEFAULT_* 默认值。
// 返回的配置对象被多处引用（send-reply、claude-runner、state 等），每次调用都会重新读取文件
export function loadPromptDocument() {
  let data;
  try { data = JSON.parse(readFileSync(PROMPTS_FILE, "utf-8")); } catch { data = {}; }
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

export function loadPrompts(profile = "") {
  const data = loadPromptDocument();
  const role = mergeRolePrompts(data, profile);
  return {
    // ── 角色人设 prompt ──
    chatStyle: role.chatStyle,
    hiddenWorldChatStyle: role.hiddenWorldChatStyle,
    expressionCapability: role.expressionCapability,
    chatRealityInstructions: role.chatRealityInstructions,
    // ── 行为控制参数 ──
    visibleContextTurns: Number.isFinite(data.visibleContextTurns) ? data.visibleContextTurns : DEFAULT_VISIBLE_CONTEXT_TURNS,
    proactiveCheckIntervalMs: Number.isFinite(data.proactiveCheckIntervalMs) ? data.proactiveCheckIntervalMs : DEFAULT_PROACTIVE_CHECK_INTERVAL_MS,
    proactiveCooldownMs: Number.isFinite(data.proactiveCooldownMs) ? data.proactiveCooldownMs : DEFAULT_PROACTIVE_COOLDOWN_MS,
    proactiveDailyMax: Number.isFinite(data.proactiveDailyMax) ? data.proactiveDailyMax : DEFAULT_PROACTIVE_DAILY_MAX,
    dailyShareSeedIntervalMs: Number.isFinite(data.dailyShareSeedIntervalMs) ? data.dailyShareSeedIntervalMs : DEFAULT_DAILY_SHARE_SEED_INTERVAL_MS,
    dailyShareMinIdleMs: Number.isFinite(data.dailyShareMinIdleMs) ? data.dailyShareMinIdleMs : DEFAULT_DAILY_SHARE_MIN_IDLE_MS,
    // ── RAG 记忆检索参数 ──
    ragTopK: Number.isFinite(data.ragTopK) ? data.ragTopK : DEFAULT_RAG_TOP_K,
    ragMinScore: Number.isFinite(data.ragMinScore) ? data.ragMinScore : DEFAULT_RAG_MIN_SCORE,
    ragResultMaxChars: Number.isFinite(data.ragResultMaxChars) ? data.ragResultMaxChars : DEFAULT_RAG_RESULT_MAX_CHARS,
    ragTimeoutMs: Number.isFinite(data.ragTimeoutMs) ? data.ragTimeoutMs : DEFAULT_RAG_TIMEOUT_MS,
    // ── 各功能模块的 system prompt ──
    sceneletInstructions: role.sceneletInstructions,
    memoryUpdatePrompt: role.memoryUpdatePrompt,
    proactiveInstructions: role.proactiveInstructions,
    scheduleCreatorInstructions: role.scheduleCreatorInstructions,
    // ── 日本季节/月历知识库（按月索引）──
    seasonalMonthlyNotes: data.seasonalMonthlyNotes || DEFAULT_SEASONAL_MONTHLY_NOTES,
    // ── 日程/计划相关参数 ──
    scheduleSpecialDates: role.scheduleSpecialDates,
    scheduleCheckIntervalMs: Number.isFinite(data.scheduleCheckIntervalMs) ? data.scheduleCheckIntervalMs : DEFAULT_SCHEDULE_CHECK_INTERVAL_MS,
    // ── 隐藏世界 + follow-up ──
    hiddenWorldMaxPendingIntents: Number.isFinite(data.hiddenWorldMaxPendingIntents) ? data.hiddenWorldMaxPendingIntents : DEFAULT_HIDDEN_WORLD_MAX_PENDING_INTENTS,
    // ── 每日分享 / 主动消息参数 ──
    dailyShareDefaultScheduleOffsetMs: Number.isFinite(data.dailyShareDefaultScheduleOffsetMs) ? data.dailyShareDefaultScheduleOffsetMs : DEFAULT_DAILY_SHARE_DEFAULT_SCHEDULE_OFFSET_MS,
    dailyShareDefaultExpiryOffsetMs: Number.isFinite(data.dailyShareDefaultExpiryOffsetMs) ? data.dailyShareDefaultExpiryOffsetMs : DEFAULT_DAILY_SHARE_DEFAULT_EXPIRY_OFFSET_MS,
    dailyShareDefaultCancelIf: Array.isArray(data.dailyShareDefaultCancelIf) ? data.dailyShareDefaultCancelIf.map(x => String(x).trim()).filter(Boolean) : DEFAULT_DAILY_SHARE_DEFAULT_CANCEL_IF,
    proactiveDefaultExpiryOffsetMs: Number.isFinite(data.proactiveDefaultExpiryOffsetMs) ? data.proactiveDefaultExpiryOffsetMs : DEFAULT_PROACTIVE_DEFAULT_EXPIRY_OFFSET_MS,
    // ── 日程细节限制 ──
    scheduleFinalizationTimeoutMs: Number.isFinite(data.scheduleFinalizationTimeoutMs) ? data.scheduleFinalizationTimeoutMs : DEFAULT_SCHEDULE_FINALIZATION_TIMEOUT_MS,
    scheduleRecentKindsLimit: Number.isFinite(data.scheduleRecentKindsLimit) ? data.scheduleRecentKindsLimit : DEFAULT_SCHEDULE_RECENT_KINDS_LIMIT,
    scheduleBasisMaxLength: Number.isFinite(data.scheduleBasisMaxLength) ? data.scheduleBasisMaxLength : DEFAULT_SCHEDULE_BASIS_MAX_LENGTH,
    scheduleArcTitleMaxLength: Number.isFinite(data.scheduleArcTitleMaxLength) ? data.scheduleArcTitleMaxLength : DEFAULT_SCHEDULE_ARC_TITLE_MAX_LENGTH,
    scheduleExpiryAfterEndBufferMs: Number.isFinite(data.scheduleExpiryAfterEndBufferMs) ? data.scheduleExpiryAfterEndBufferMs : DEFAULT_SCHEDULE_EXPIRY_AFTER_END_BUFFER_MS,
    scheduleDefaultExpiryFromNowMs: Number.isFinite(data.scheduleDefaultExpiryFromNowMs) ? data.scheduleDefaultExpiryFromNowMs : DEFAULT_SCHEDULE_DEFAULT_EXPIRY_FROM_NOW_MS,
    // ── 消息发送 ──
    chunkSendDelayMs: Number.isFinite(data.chunkSendDelayMs) ? data.chunkSendDelayMs : DEFAULT_CHUNK_SEND_DELAY_MS,
    maxCancelReasonLength: Number.isFinite(data.maxCancelReasonLength) ? data.maxCancelReasonLength : DEFAULT_MAX_CANCEL_REASON_LENGTH,
    // ── prompt 文本 ──
    visionCaptionPrompt: data.visionCaptionPrompt || DEFAULT_VISION_CAPTION_PROMPT,
    ragContextInstruction: role.ragContextInstruction,
    chatHistoryIntro: role.chatHistoryIntro,
    innerSceneletIntro: role.innerSceneletIntro,
    sceneletReplyBridgeInstruction: role.sceneletReplyBridgeInstruction,
    memoryContextInstruction: role.memoryContextInstruction,
    ragKeywords: normalizeRagKeywords(data.ragKeywords),
    turnResetThreshold: Number.isFinite(data.turnResetThreshold) ? data.turnResetThreshold : DEFAULT_TURN_RESET_THRESHOLD,
    sceneMemorySystemBlockIntro: role.sceneMemorySystemBlockIntro,
    sceneMemoryPromptInstructions: role.sceneMemoryPromptInstructions,
    dailyShareSeedPrompt: role.dailyShareSeedPrompt,
    timeAdvancementPrompt: role.timeAdvancementPrompt,
    stateStaleThresholdMs: Number.isFinite(data.stateStaleThresholdMs) ? data.stateStaleThresholdMs : DEFAULT_STATE_STALE_THRESHOLD_MS,
    scheduleExtractorPrompt: role.scheduleExtractorPrompt,
  };
}

// 获取聊天风格 prompt（便捷访问器）
export function getChatStyle(profile = "") {
  return loadPrompts(profile).chatStyle;
}

// WeChat ilink API 单条消息字节上限约 2048 字节，留安全余量设为 1800
export const MAX_REPLY_LEN = 1800;

// 根据小时数返回中文时间段称谓
function timePeriodFromHour(hour) {
  if (hour < 5) return "凌晨";
  if (hour < 8) return "早上";
  if (hour < 11) return "上午";
  if (hour < 13) return "中午";
  if (hour < 18) return "下午";
  if (hour < 23) return "晚上";
  return "深夜";
}

// 将日期按指定时区格式化为中文时间片段，返回 stamp、weekday、shortWeekday、period
export function formatZonedTimeParts(date = new Date(), timeZone = "Asia/Shanghai") {
  const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const shortWeekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const parts = Object.fromEntries(new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  const weekdayValue = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayValue);
  const hour = Number(parts.hour || 0);
  const stamp = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  return {
    stamp,
    weekday: weekdays[weekdayIndex] || weekdays[date.getDay()],
    shortWeekday: shortWeekdays[weekdayIndex] || shortWeekdays[date.getDay()],
    period: timePeriodFromHour(hour),
    timeZone,
  };
}

// 生成双时区时间感知文本：用户侧北京时间 + 角色侧东京时间
export function formatLocalChatReality(date = new Date(), profile = "") {
  const beijing = formatZonedTimeParts(date, "Asia/Shanghai");
  const tokyo = formatZonedTimeParts(date, "Asia/Tokyo");
  return [
    `当前用户侧时间：${beijing.stamp}，${beijing.weekday}，${beijing.period}（北京时间，Asia/Shanghai）。`,
    `当前角色侧时间：${tokyo.stamp}，${tokyo.weekday}，${tokyo.period}（东京时间，Asia/Tokyo；角色所处时间以此为准）。`,
    "",
    loadPrompts(profile).chatRealityInstructions,
  ].join("\n");
}

export function expressionCapabilityPrompt(profile = "") {
  return loadPrompts(profile).expressionCapability;
}

// ─── 消息拆分 ────────────────────────────────────────────────

// 按 UTF-8 字节上限拆分消息，优先按段落边界拆分，超长单段落按句子边界拆分
export function splitText(text, maxBytes = MAX_REPLY_LEN) {
  const byteLen = Buffer.byteLength(text, "utf-8");
  if (byteLen <= maxBytes) return [text];

  const chunks = [];
  const paragraphs = text.split(/\n/);
  let current = "";

  for (const para of paragraphs) {
    const sep = current ? "\n" : "";
    const candidate = current ? current + sep + para : para;
    if (Buffer.byteLength(candidate, "utf-8") <= maxBytes) {
      current = candidate;
    } else {
      if (current) {
        chunks.push(current);
        current = "";
      }
      // 对超长的单个段落，按句子边界（句号、感叹号、问号等）进行拆分
      let remaining = para;
      while (Buffer.byteLength(remaining, "utf-8") > maxBytes) {
        const estChars = Math.floor(maxBytes / 3); // 对 CJK 字符取保守估算（每个 CJK 字符约占 3 字节）
        const slice = remaining.slice(0, estChars);
        let bestBreak = -1;
        for (const bp of ["。", "！", "？", "!", "?", "\n"]) {
          const pos = slice.lastIndexOf(bp);
          if (pos > bestBreak) bestBreak = pos;
        }
        if (bestBreak > 0) {
          chunks.push(remaining.slice(0, bestBreak + 1));
          remaining = remaining.slice(bestBreak + 1);
        } else {
          chunks.push(remaining.slice(0, estChars));
          remaining = remaining.slice(estChars);
        }
      }
      if (remaining.trim()) {
        current = remaining;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text];
}

// ─── 附件/特殊消息检测 ────────────────────────────────────────

// 检测用户消息是否为图片/语音/文件/视频附件
export function hasInboundAttachment(body) {
  return /^\[(图片|语音|文件|视频)\]/m.test(body);
}

// 检测回复是否包含 markdown 代码块、表格、列表等结构化内容
// 结构化回复不参与社交拆分（避免破坏格式）
export function isStructuredReply(text) {
  return /```|^\s*#{1,6}\s|^\s*[-*]\s|^\s*\d+[.)]\s|^\s*[>|]/m.test(text)
    || /===|--- Tool:|Result:|\[usage\]|❌|⚠️|⏹️/.test(text);
}

// ─── 社交风格回复拆分 ──────────────────────────────────────────
// 让 AI 回复更像真人聊天：通过随机概率将长回复拆成多条短消息发送

// 检测文本是否有"爆发言"特征（感叹、重复语气词等），这类文本更倾向拆分
function hasBurstReason(text) {
  return /[！？!?…~～]{2,}|哈{2,}|h{2,}|欸|诶|呜|哇|啊这|等等|不是|真的|草|救命|怎么会/u.test(text);
}

// 根据文本特征和句子数，以随机概率决定是否拆分
function shouldSplitImplicitly(text, sentences) {
  if (Buffer.byteLength(text, "utf-8") > MAX_REPLY_LEN) return true;
  const r = Math.random();
  if (hasBurstReason(text)) return r < 0.65;
  if (sentences.length >= 5) return r < 0.35;
  if (sentences.length >= 3) return r < 0.18;
  return r < 0.08;
}

// 随机返回一个字符数上限，用于将句子拼成不同长度的"气泡"
function randomBeatLimit() {
  const limits = [12, 18, 24, 32, 46, 70, 110];
  return limits[Math.floor(Math.random() * limits.length)];
}

// 将句子按随机长度上限拼接为多个"气泡"块
function makeChatBeats(sentences) {
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if (!current) {
      current = sentence;
    } else if ((current + sentence).length <= randomBeatLimit()) {
      current += sentence;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// 入口：将 AI 回复拆分为多条消息
// 优先按自然段落拆分（≥2 段且非结构化内容），其次按句子 + 随机概率拆分
export function splitSocialReply(text) {
  const paragraphs = String(text || "")
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map(s => s.trim())
    .filter(Boolean);
  if (!isStructuredReply(text)) {
    const explicitParts = paragraphs.flatMap(paragraph => {
      const lines = paragraph.split("\n").map(s => s.trim()).filter(Boolean);
      const parts = [];
      let current = [];
      for (const line of lines) {
        if (/^[（(][\s\S]*[）)]$/u.test(line)) {
          if (current.length) parts.push(current.join("\n"));
          current = [];
          parts.push(line);
        } else {
          current.push(line);
        }
      }
      if (current.length) parts.push(current.join("\n"));
      return parts;
    });
    if (explicitParts.length >= 2) return explicitParts;
  }
  const sentences = text
    .replace(/\r/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/([。！？!?\n])\s*/g, "$1\n")
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);
  if (!sentences.length) return [text.trim()];
  if (shouldSplitImplicitly(text, sentences)) {
    return makeChatBeats(sentences);
  }
  return [text.trim()];
}

