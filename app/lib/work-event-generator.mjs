// work-event-generator.mjs — 日程预生成器
// 独立于对话流程，为启用角色（当前聚焦千圣）主动生成结构化工作日程。
// 采用混合方案：JSON 模板池提供骨架（代码随机抽取，保证多样性），模型填充血肉。
// 生成结果在提交前按最新世界状态二次校验，再以无 await 的临界段直接写入 life_arcs。

import { getRoleWorld, saveRoleWorlds, lifeArcPromptItems, roleWorldKey, applyLifeArcOps } from "./world-state.mjs";
import { normalizeLifeArcs, getSceneConfig } from "./normalize.mjs";
import { runBackendStructured, backendModel } from "./backend-adapter.mjs";
import { activeAI, profileTemplates } from "./state.mjs";
import { loadPrompts, tokyoISO } from "./reply.mjs";

// ─── 全局并发控制 ────────────────────────────────────────────────
let isRunning = false;
const lastStatusByProfile = new Map();

function reportStatus(result) {
  if (!result?.profile || !result?.status) return;
  const previous = lastStatusByProfile.get(result.profile);
  lastStatusByProfile.set(result.profile, result.status);
  if (previous === result.status && result.status === "cooldown") return;
  const details = [];
  if (result.generated !== undefined) details.push(`generated=${result.generated}`);
  if (result.reason) details.push(`reason=${result.reason}`);
  if (result.error) details.push(`error=${result.error}`);
  console.log(`[work-event-generator] ${result.profile}: ${result.status}${details.length ? ` (${details.join(", ")})` : ""}`);
}

// ─── 角色启用检查 ──────────────────────────────────────────────────
function enabledProfiles() {
  const list = [];
  for (const profile of Object.keys(profileTemplates || {})) {
    const cfg = loadPrompts(profile);
    if (cfg.workEventConfig?.enabled) list.push(profile);
  }
  return list;
}

// ─── 量级自动分类 ──────────────────────────────────────────────────
function autoClassifyScale(durationHours, durationDays) {
  if (durationHours >= 8 || durationDays > 1) return "heavy";
  if (durationHours >= 4) return "medium";
  return "light";
}

function minLeadHours(scale, config) {
  const defaults = { light: 24, medium: 48, heavy: 72 };
  return config?.minLeadHours?.[scale] ?? defaults[scale];
}

// 各量级向前看的最大天数——大型工作提前更早知道，小型工作一周内即可
function maxLookaheadDays(scale) {
  const defaults = { light: 7, medium: 14, heavy: 21 };
  return defaults[scale] || 14;
}

// ─── 东京时间辅助 ───────────────────────────────────────────────────
function tokyoNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
}

function tokyoNowISO() {
  return tokyoISO();
}

// 将任意时间转为 JST 日期字符串 (YYYY/MM/DD)
function jstDateStr(isoOrDate) {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(isoOrDate));
}

// ─── 模板抽取 ──────────────────────────────────────────────────────
// 冷却窗口：最近 N 个已抽取的 template index，同 subtype 不连续出现
const COOLING_WINDOW_SIZE = 5;

function pickTemplate(templates, coolingIndices = []) {
  if (!templates?.length) return null;

  // 构建加权池：weight > 0 且不在冷却窗口内（除非 repeatable）
  const pool = [];
  let totalWeight = 0;
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    if (!t || typeof t !== "object") continue;
    if (typeof t.weight === "number" && t.weight <= 0) continue; // 条件触发模板不进入普通池
    const inCooldown = !t.repeatable && coolingIndices.includes(i);
    if (inCooldown) continue;
    const w = typeof t.weight === "number" ? t.weight : 1.0;
    pool.push({ index: i, template: t, weight: w });
    totalWeight += w;
  }

  if (!pool.length) return null;

  // 加权随机
  let r = Math.random() * totalWeight;
  for (const item of pool) {
    r -= item.weight;
    if (r <= 0) return { index: item.index, template: item.template };
  }
  return { index: pool[pool.length - 1].index, template: pool[pool.length - 1].template };
}

// 条件触发：检查是否有 weight:0 的模板满足前置条件
function checkConditionalTemplates(templates, lifeArcs) {
  const result = [];
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    if (typeof t.weight !== "number" || t.weight > 0) continue;
    // 全国巡演：近 45 天内存在 CD录制 或 MV拍摄 的 life_arc
    if (t.subtype === "全国ツアー") {
      const cutoff = tokyoISO(new Date(tokyoNow().getTime() - 45 * 86400000));
      const hasTrigger = (lifeArcs || []).some(a => {
        const relevantDate = a.timeStart || a.timeEnd || a.createdAt || "";
        return relevantDate >= cutoff && (a.summary || "").includes("CD录制") || (a.summary || "").includes("MV拍摄")
          || (a.title || "").includes("CD录制") || (a.title || "").includes("MV拍摄");
      });
      if (hasTrigger) result.push({ index: i, template: { ...t, weight: 1.0 } });
    }
  }
  return result;
}

// ─── 时间 slot 格式化 ──────────────────────────────────────────────
function formatTimeSlotsForPrompt(lifeArcs) {
  // 展开所有有 time_slots 的 life_arc 为具体日期+时间段列表
  const lines = [];
  const now = tokyoNow();
  const nowStr = tokyoISO(now).slice(0, 10);

  for (const arc of (lifeArcs || [])) {
    if (!arc.timeSlots?.length) continue;
    const arcTitle = arc.title || "未命名";
    for (const slot of arc.timeSlots) {
      if (slot.date) {
        lines.push(`- ${slot.date} ${slot.start}-${slot.end}：${arcTitle}（${arc.kind || ""}）`);
      } else if (slot.dayOfWeek) {
        // 找出未来 7 天内符合条件的日期
        const dayNames = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
        lines.push(`- 每${dayNames[slot.dayOfWeek] || "?"} ${slot.start}-${slot.end}：${arcTitle}（${arc.kind || ""}）`);
      }
    }
  }
  return lines.length ? lines.join("\n") : "（无确定时间安排）";
}

function formatSoftHintsForPrompt(lifeArcs) {
  // 有 timeStart/timeEnd 但无 time_slots 的 life_arc
  const hints = [];
  for (const arc of (lifeArcs || [])) {
    if (arc.timeSlots?.length) continue; // 有 time_slots 的已在 Level 1 覆盖
    if (!arc.timeStart && !arc.timeEnd) continue;
    const title = arc.title || "未命名";
    const kind = arc.kind || "";
    const start = arc.timeStart ? arc.timeStart.slice(0, 10) : "";
    const end = arc.timeEnd ? arc.timeEnd.slice(0, 10) : "";
    const dateRange = start && end ? `${start} 至 ${end}` : start || end || "日期未定";
    hints.push(`- ${dateRange}：${title}（${kind}）`);
  }
  return hints.length ? hints.join("\n") : "（无）";
}

// ─── 已有工作事件进度摘要 ──────────────────────────────────────────
function formatWorkProgressSummary(lifeArcs) {
  const workArcs = (lifeArcs || []).filter(a => a.kind === "work" && a.status === "active");
  if (!workArcs.length) return "（无进行中的工作事件）";
  return workArcs.map(a => {
    const timeStr = a.timeStart ? a.timeStart.slice(0, 10) : "?";
    return `- [${timeStr}] ${a.title}：${a.progressNote || "无进度记录"}`;
  }).join("\n");
}

// ─── 冲突检测 ──────────────────────────────────────────────────────

function timeToMinutes(timeStr) {
  if (!timeStr) return null;
  const parts = String(timeStr).split(":");
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1] || "0", 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

function slotsOverlap(slot1Start, slot1End, slot2Start, slot2End) {
  const s1 = timeToMinutes(slot1Start);
  const e1 = timeToMinutes(slot1End);
  const s2 = timeToMinutes(slot2Start);
  const e2 = timeToMinutes(slot2End);
  if (s1 == null || e1 == null || s2 == null || e2 == null) return false;
  return s1 < e2 && s2 < e1;
}

// 判断候选事件的日期是否与某个 time_slot 的日期/星期匹配
function slotMatchesDate(slot, dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  if (slot.date) return slot.date === dateStr.slice(0, 10);
  if (slot.dayOfWeek) {
    // JS getDay(): 0=Sun, 1=Mon, ..., 6=Sat
    // dayOfWeek: 1=Mon, ..., 7=Sun
    const jsDay = d.getDay();
    const adjusted = jsDay === 0 ? 7 : jsDay;
    return adjusted === slot.dayOfWeek;
  }
  return false;
}

// 获取候选事件跨越的日期列表
function eventDateRange(timeStart, timeEnd) {
  if (!timeStart || !timeEnd) return [];
  const dates = [];
  const start = new Date(timeStart);
  const end = new Date(timeEnd);
  const cur = new Date(tokyoISO(start).slice(0, 10));
  const endDate = new Date(tokyoISO(end).slice(0, 10));
  while (cur <= endDate) {
    dates.push(tokyoISO(cur).slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function checkLevel1Conflict(candidate, lifeArcs) {
  // Level 1：与所有有 time_slots 的 life_arc 做硬时间重叠检测
  if (!candidate.time_start || !candidate.time_end) return [];
  const candDates = eventDateRange(candidate.time_start, candidate.time_end);
  const candStart = candidate.time_start.slice(11, 16);
  const candEnd = candidate.time_end.slice(11, 16);

  const conflicts = [];
  for (const arc of (lifeArcs || [])) {
    if (!arc.timeSlots?.length) continue;
    for (const slot of arc.timeSlots) {
      for (const date of candDates) {
        if (!slotMatchesDate(slot, date)) continue;
        if (slotsOverlap(candStart, candEnd, slot.start, slot.end)) {
          conflicts.push({
            arcTitle: arc.title || "未命名",
            arcKind: arc.kind || "",
            slotDate: date,
            slotRange: `${slot.start}-${slot.end}`,
          });
        }
      }
    }
  }
  return conflicts;
}

function checkLevel2Density(candidate, lifeArcs, workHoursPerDay = 8) {
  // Level 2：当天密度和 ≤ 1.0
  // 检查 candidate 覆盖的每一天，是否已有工作事件导致当天密度超标
  if (!candidate.time_start || !candidate.time_end) return [];
  const candHours = candidate.duration_hours || 0;
  if (!candHours) return [];

  const violations = [];
  const candDates = eventDateRange(candidate.time_start, candidate.time_end);
  const candDays = candDates.length || 1;
  const dailyHours = candHours / candDays;

  for (const date of candDates) {
    let totalHours = dailyHours;
    const existingOnDate = [];

    for (const arc of (lifeArcs || [])) {
      if (arc.status === "closed") continue;
      if (!arc.timeStart || !arc.timeEnd) continue;
      const arcDates = eventDateRange(arc.timeStart, arc.timeEnd);
      if (!arcDates.includes(date)) continue;
      const arcDays = arcDates.length || 1;
      const arcDuration = (arc.duration_hours || 0) > 0 ? arc.duration_hours : (
        arc.summary?.includes("duration_hours") ? 0 : 0
      );
      if (!arcDuration) continue;
      const arcDaily = arcDuration / arcDays;
      totalHours += arcDaily;
      existingOnDate.push(`${arc.title || "?"}（${arcDaily.toFixed(1)}h）`);
    }

    if (totalHours > workHoursPerDay) {
      violations.push({
        date,
        totalHours: totalHours.toFixed(1),
        limit: workHoursPerDay,
        existing: existingOnDate,
      });
    }
  }
  return violations;
}

function checkWorkingHoursConstraint(timeStart, timeEnd) {
  // 工作时间带：07:00-22:00 内
  const startMin = timeToMinutes(timeStart?.slice(11, 16));
  const endMin = timeToMinutes(timeEnd?.slice(11, 16));
  const dayStart = 7 * 60;  // 07:00
  const dayEnd = 22 * 60;   // 22:00
  if (startMin == null || endMin == null) return false;
  return startMin >= dayStart && endMin <= dayEnd;
}

// ─── 代码层校验 ─────────────────────────────────────────────────────
function validateEvent(event, config, lifeArcs, expectedJstDate = null) {
  const errors = [];
  const warnings = [];
  const workHoursPerDay = config?.workHoursPerDay || 8;
  const policy = config?.conflictPolicy || {};
  const now = tokyoNow();
  const nowISO = tokyoISO(now);

  if (!event) return { valid: false, errors: ["event is null"] };

  // 字段完整性
  if (!event.title || !event.summary || !event.time_start || !event.time_end) {
    errors.push("缺少必填字段（title/summary/time_start/time_end）");
    return { valid: false, errors, warnings };
  }

  const startDate = new Date(event.time_start);
  const endDate = new Date(event.time_end);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    errors.push("时间格式无效");
    return { valid: false, errors, warnings };
  }

  // 不生成今天及过去（JST 日期）
  const todayJst = jstDateStr(new Date());
  const eventJstDate = jstDateStr(event.time_start);
  if (eventJstDate <= todayJst) {
    errors.push(`开始日期 ${eventJstDate} JST 不晚于今天 ${todayJst} JST`);
    return { valid: false, errors, warnings };
  }

  // 日期必须匹配代码层选定的日期（模型只调钟点）
  if (expectedJstDate) {
    if (eventJstDate !== expectedJstDate) {
      errors.push(`开始日期 ${eventJstDate} JST 与固定日期 ${expectedJstDate} JST 不匹配`);
      return { valid: false, errors, warnings };
    }
  }

  // start 必须在窗口内（JST 日期比较）
  const scale = autoClassifyScale(event.duration_hours || 0, event.duration_days || 1);
  const leadH = minLeadHours(scale, config);
  const lookaheadDays = maxLookaheadDays(scale);
  const earliestUtc = new Date(now.getTime() + leadH * 3600000);
  const windowEndUtc = new Date(now.getTime() + lookaheadDays * 86400000);

  if (startDate < earliestUtc) {
    errors.push(`开始时间早于最早允许时间（minLead=${leadH}h）`);
  }
  const windowEndJstDate = jstDateStr(windowEndUtc);
  if (eventJstDate > windowEndJstDate) {
    errors.push(`开始日期 ${eventJstDate} JST 超出窗口上限 ${windowEndJstDate} JST（${lookaheadDays}天）`);
  }

  // 工作时间带（仅 warning，深夜音番等除外）
  if (!checkWorkingHoursConstraint(event.time_start, event.time_end)) {
    // 检查模板 note 是否注明了例外
    warnings.push(`工作时间超出 07:00-22:00（${event.time_start.slice(11, 16)}-${event.time_end.slice(11, 16)}）`);
  }

  // 结束时间必须晚于开始时间
  if (endDate <= startDate) {
    errors.push(`结束时间 ${event.time_end} 不晚于开始时间 ${event.time_start}`);
  }

  // 多日事件时长合理性
  const eventDurationMs = endDate.getTime() - startDate.getTime();
  const eventDays = Math.ceil(eventDurationMs / 86400000) || 1;
  if (eventDays > 14) {
    errors.push(`事件跨度过长（${eventDays}天），超过最大允许14天`);
  }

  // Level 1 冲突
  const level1Conflicts = checkLevel1Conflict(event, lifeArcs);
  if (level1Conflicts.length) {
    const scalePolicy = policy[scale] || { allow: false };
    const allowConflict = scalePolicy.allow === true
      || (scalePolicy.allow === "school_only" && level1Conflicts.every(c => c.arcKind === "school"));

    if (!allowConflict) {
      const conflictDesc = level1Conflicts.map(c => `${c.slotDate} ${c.slotRange} 与 ${c.arcTitle} 冲突`).join("; ");
      errors.push(`Level 1 时间冲突：${conflictDesc}`);
    }
  }

  // Level 2 密度
  const densityViolations = checkLevel2Density(event, lifeArcs, workHoursPerDay);
  if (densityViolations.length) {
    const desc = densityViolations.map(v => `${v.date} 工时 ${v.totalHours}h > ${v.limit}h`).join("; ");
    errors.push(`Level 2 密度超标：${desc}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    scale,
  };
}

// ─── 冷却窗口管理 ──────────────────────────────────────────────────
function updateCoolingWindow(roleWorld, templateIndex) {
  if (!roleWorld._lastGenerationTemplateIndices) {
    roleWorld._lastGenerationTemplateIndices = [];
  }
  const window = roleWorld._lastGenerationTemplateIndices;
  window.push(templateIndex);
  while (window.length > COOLING_WINDOW_SIZE) window.shift();
}

// ─── 单角色运行 ─────────────────────────────────────────────────────
async function runForProfile(profile, opts = {}) {
  const cfg = loadPrompts(profile);
  if (!cfg.workEventConfig?.enabled) return { profile, status: "disabled" };

  const roleWorld = getRoleWorld(profile);
  if (!roleWorld) return { profile, status: "no_world" };

  const config = cfg.workEventConfig;
  const templates = cfg.workEventTemplates;
  const workEventPrompt = cfg.workEventPrompt;
  if (!templates?.length || !workEventPrompt) return { profile, status: "no_templates" };

  // 检查生成间隔
  const now = tokyoNow();
  const lastGen = roleWorld._lastWorkEventGenerationAt ? new Date(roleWorld._lastWorkEventGenerationAt) : null;
  if (!opts.force && lastGen) {
    const elapsed = now.getTime() - lastGen.getTime();
    if (elapsed < (config.generationIntervalMs || 12 * 3600000)) return { profile, status: "cooldown", elapsedMs: elapsed, intervalMs: config.generationIntervalMs || 12 * 3600000 };
  }

  const workHoursPerDay = config.workHoursPerDay || 8;
  const normalizedArcs = normalizeLifeArcs(roleWorld._lifeArcs, { includeClosed: false });
  const allArcs = lifeArcPromptItems(roleWorld);

  // 条件触发模板
  const conditionalTemplates = checkConditionalTemplates(templates, normalizedArcs);

  // 合并普通池 + 条件触发模板
  const effectiveTemplates = [...templates];
  for (const ct of conditionalTemplates) {
    // 临时注入到池中（clone 以避免污染缓存）
    effectiveTemplates.push(ct.template);
  }

  // 随机抽取模板
  const coolingIndices = roleWorld._lastGenerationTemplateIndices || [];
  const pick = pickTemplate(effectiveTemplates, coolingIndices);
  if (!pick) return { profile, status: "all_cooling" };

  const template = pick.template;
  const durationHours = template.duration_hours || 0;
  const durationDays = template.duration_days || 1;
  const scale = autoClassifyScale(durationHours, durationDays);
  const leadH = minLeadHours(scale, config);
  const lookaheadDays = maxLookaheadDays(scale);
  const earliest = new Date(now.getTime() + leadH * 3600000);
  const windowEndDate = new Date(now.getTime() + lookaheadDays * 86400000);
  const minGapMinutes = config.conflictPolicy?.minGapBetweenEventsMinutes ?? 60;

  // 代码层在窗口内随机选定起始日期 —— 模型只调钟点，不参与日期决策
  // 全程用 JST 日期计算，避免 UTC/JST 跨天导致校验误杀
  const pickRandomDate = (earliestDate, windowEnd) => {
    const parseJstDate = (d) => {
      const [y, m, day] = jstDateStr(d).split("/").map(Number);
      return { y, m, d: day };
    };
    const earliestJst = parseJstDate(earliestDate);
    const windowEndJst = parseJstDate(windowEnd);
    // 从 earliest JST 到 windowEnd JST 之间的天数（用 UTC noon 计算避免 DST 干扰）
    const earliestUtcNoon = Date.UTC(earliestJst.y, earliestJst.m - 1, earliestJst.d, 3); // 12:00 JST = 03:00 UTC
    const windowEndUtcNoon = Date.UTC(windowEndJst.y, windowEndJst.m - 1, windowEndJst.d, 3);
    const dayCount = Math.round((windowEndUtcNoon - earliestUtcNoon) / 86400000);
    const offset = Math.floor(Math.random() * (Math.max(0, dayCount) + 1));
    const pickedUtcNoon = earliestUtcNoon + offset * 86400000;
    const pickedJstDate = jstDateStr(pickedUtcNoon);
    const weekday = ["日", "一", "二", "三", "四", "五", "六"][new Date(pickedUtcNoon).getUTCDay()];
    return {
      jstDate: pickedJstDate,
      weekday,
      jstRange: `${pickedJstDate} 07:00-22:00 JST`,
    };
  };
  const pickedDate = pickRandomDate(earliest, windowEndDate);

  // 冲突策略描述
  const scalePolicy = config.conflictPolicy?.[scale] || { allow: false };
  let conflictRuleText;
  if (scalePolicy.allow === true) conflictRuleText = "本量级允许与所有类型 time_slots 时间冲突";
  else if (scalePolicy.allow === "school_only") conflictRuleText = "本量级只允许与 school 类型 time_slots 时间冲突（可与课程时间重叠），与其他类型冲突仍应拒绝";
  else conflictRuleText = "本量级不允许与任何已有 time_slots 时间冲突，必须完全避开";

  // 构建 prompt
  const promptText = [
    workEventPrompt,
    "",
    "【抽取到的模板】",
    JSON.stringify(template, null, 2),
    "",
    `【当前时间】`,
    `${tokyoNowISO()}（星期${["日", "一", "二", "三", "四", "五", "六"][now.getDay()]}）`,
    "",
    `【固定日期·代码选定】工作安排在 ${pickedDate.jstDate}（周${pickedDate.weekday}）`,
    `  time_start 的日期必须是 ${pickedDate.jstDate}，你只能根据工作类型选择合适的开始钟点（${pickedDate.jstRange}）。`,
    `  使用 ISO 8601 格式输出，日期部分不可变动。`,
    "",
    "【已有确定时间安排】",
    formatTimeSlotsForPrompt(allArcs),
    "",
    "【已有工作事件的进度状态】",
    formatWorkProgressSummary(allArcs),
    "",
    "【以下日期有安排但时间未定，尽量避免全天工作】",
    formatSoftHintsForPrompt(allArcs),
    "",
    "【约束】",
    `- 事件在模板时长框架内（${durationHours}h × ${durationDays}天）`,
    "- 不生成今天或过去的日程",
    "- 事件起止时间应在 07:00-22:00 JST 内（深夜音番/直播等模板备注注明的例外除外）",
    `- 多日事件每日实际工时尽量平均分配，单日不超过 ${workHoursPerDay}h`,
    `- 当天所有事件的密度之和（duration_hours / ${workHoursPerDay}）≤ 1.0`,
    "- 不要连续安排 heavy 事件；若已有日程中近期有 heavy，倾向于返回空或选择更轻量的事件",
    `- ${conflictRuleText}`,
    "- 两个工作事件的时间范围不得重叠",
    `- 事件之间至少间隔 ${minGapMinutes} 分钟`,
    "- 对【日期未定安排】，尽量回避或留出弹性；无法避开时在 progress_note 中注明需要协调",
    "- 日本演艺圈有季节性节奏（年末年始、黄金周、盂兰盆等），如当前日期临近这些时段请适当降低安排密度或返回空",
    "",
    "【输出格式】",
    "只输出 JSON：",
    '{"events":[{"title":"具体工作名称（含节目名/期数/项目名，≤80字）","summary":"工作内容概要（含主题、地点、合作者等，≤500字）","time_start":"ISO 8601（日期必须等于上述固定日期）","time_end":"ISO 8601","progress_note":"当前准备状态或进度","duration_hours":数字,"duration_days":数字}],"reason":"生成理由简述"}',
    '没有合适日程时返回：{"events":[],"reason":"说明原因"}',
    "",
    "【生成指引】",
    "- title 要具体可辨认，非泛化的\"工作\"或\"综艺录制\"",
    "- summary 包含够多具体信息，让 Actor 后续对话中可以自然引用",
    "- progress_note 反映事件当前准备状态，不要与【已有工作事件的进度状态】中列出的进度矛盾",
    "- 骨架框架下确实没有合适安排时，宁可返回空，不勉强生成",
    "- 所有输出必须使用中文（包括 reason、title、summary、progress_note）",
  ].join("\n");

  // 调用 AI
  const label = `work_event_gen_${profile}`;
  let result = null;
  try {
    result = await runBackendStructured(promptText, {
      backend: activeAI,
      label,
      bare: true,
      persist: false,
      timeoutMs: 300_000,
      systemPrompt: `你是 ${profile} 的日程预生成器。根据给定的工作模板骨架，为角色生成一个具体的、未来会发生的真实工作日程。`,
      profile,
    });
  } catch (e) {
    console.log(`[work-event-generator] AI call failed for ${profile}: ${e.message}`);
    return { profile, status: "ai_error", error: e.message };
  }

  if (!result || !result.events) return { profile, status: "no_result" };

  // 处理返回空的情况
  if (!result.events.length) {
    console.log(`[work-event-generator] ${profile}: no events generated. reason: ${result.reason || "none"}`);
    // 即使返回空也记录 generation time，避免反复空跑
    roleWorld._lastWorkEventGenerationAt = tokyoNowISO();
    updateCoolingWindow(roleWorld, pick.index);
    saveRoleWorlds();
    return { profile, status: "empty", reason: result.reason || "none", template: template.type || "unknown" };
  }

  // 校验并通过的事件入队
  let enqueued = 0;
  for (const event of result.events.slice(0, config.maxEventsPerGeneration || 1)) {
    // 补上模板的时长信息供校验使用
    event.duration_hours = event.duration_hours ?? durationHours;
    event.duration_days = event.duration_days ?? durationDays;

    const validation = validateEvent(event, config, normalizedArcs, pickedDate.jstDate);

    if (!validation.valid) {
      console.log(`[work-event-generator] ${profile}: event rejected: ${event.title}`);
      for (const err of validation.errors) {
        console.log(`  - ${err}`);
      }
      continue;
    }

    for (const w of validation.warnings) {
      console.log(`[work-event-generator] ${profile}: warning for "${event.title}": ${w}`);
    }

    // 构建 life_arc op
    const lifeArcOp = {
      op: "create",
      title: event.title,
      summary: event.summary,
      progress_note: event.progress_note || "",
      kind: "work",
      subject: "role",
      time_start: event.time_start,
      time_end: event.time_end,
      // 按模板字段设置过期时间
      expires_at: tokyoISO(new Date(new Date(event.time_end).getTime() + 86400000)),
    };

    // AI 调用期间世界状态可能变化；提交前按当前 life_arcs 再校验一次。
    // 从二次校验到 apply+save 之间没有 await，是单线程事件循环中的原子提交段。
    const currentArcs = normalizeLifeArcs(roleWorld._lifeArcs, { includeClosed: false });
    const commitValidation = validateEvent(event, config, currentArcs, pickedDate.jstDate);
    if (!commitValidation.valid) {
      console.log(`[work-event-generator] ${profile}: event changed while generating and was rejected: ${event.title}`);
      for (const err of commitValidation.errors) console.log(`  - ${err}`);
      continue;
    }
    applyLifeArcOps(roleWorld, [lifeArcOp]);
    enqueued++;

    console.log(`[work-event-generator] ${profile}: committed "${event.title}" (${validation.scale})`);
  }

  // 更新状态
  roleWorld._lastWorkEventGenerationAt = tokyoNowISO();
  updateCoolingWindow(roleWorld, pick.index);

  saveRoleWorlds();

  if (enqueued === 0 && result.reason) {
    console.log(`[work-event-generator] ${profile}: all events rejected. reason: ${result.reason}`);
  }
  return {
    profile,
    status: enqueued > 0 ? "generated" : "rejected",
    generated: enqueued,
    template: template.type || "unknown",
    reason: enqueued > 0 ? "" : (result.reason || "all events rejected"),
  };
}

// ─── 对外入口 ───────────────────────────────────────────────────────
export async function runAll(opts = {}) {
  if (isRunning) return { status: "busy" };
  isRunning = true;
  const results = [];
  try {
    const profiles = enabledProfiles();
    if (!profiles.length) return { status: "idle", results };
    for (const profile of profiles) {
      try {
        const r = await runForProfile(profile, opts);
        if (r) {
          results.push(r);
          reportStatus(r);
        }
      } catch (e) {
        console.log(`[work-event-generator] error for ${profile}: ${e.message}`);
        const result = { profile, status: "error", error: e.message };
        results.push(result);
        reportStatus(result);
      }
    }
  } finally {
    isRunning = false;
  }
  return { status: "done", results };
}
