// ─── 命令处理模块 ────────────────────────────────────────────
// 所有微信机器人斜杠命令（/help, /cc, /codex, /api, /new,
// /switch, /rename, /sessions, /mode, /profile, /close, /status, /cancel）
// 的处理函数。从 bot.mjs 的 handleMessage() 中抽取为独立模块。

import { sendMessage, saveToken } from "./wechat.mjs";
import { activeAI, setActiveAI, sessions, profileTemplates, modelNames } from "./state.mjs";
import { isApiConfigured, resolveApiConfig, killProc } from "./claude-runner.mjs";
import { loadAllEvents } from "./chat-history.mjs";
import { makeSession, saveSessions, activeSession, ensureUser, hasSessionName, nextSessionName, findSession, sessionsListText, clearPendingInput } from "./session-store.mjs";
import { sessionProfile } from "./world-state.mjs";
import { replyPrefix } from "./turn.mjs";

// ═══════════════════════════════════════════════════════════════
// handleHelp() —— 处理 /help 命令，显示所有可用命令的帮助信息
// ═══════════════════════════════════════════════════════════════
// 输入：
//   userId - 用户微信 ID
//   ctx    - 微信上下文 token（用于指定回复目标消息）
// 输出：无（副作用：发送微信帮助消息）
export async function handleHelp(userId, ctx) {
  await sendMessage(userId, [
    `# 帮助`,
    ``,
    `【AI 切换】`,
    `/cc                 切换到 Claude Code`,
    `/codex              切换到 Codex`,
    `/api                切换到 Direct API`,
    ``,
    `【线程管理】`,
    `/new [名称]         创建新会话线程`,
    `/rename [序号|名称] <新名称>  重命名线程`,
    `/switch [序号|名称]  切换活跃线程`,
    `/sessions           查看所有线程`,
    `/close [序号|名称]   关闭线程`,
    `/cancel             取消当前运行的任务`,
    `/status             查看当前状态`,
    ``,
    `【角色管理】`,
    `/profile                     查看所有角色`,
    `/profile <名称>              切换到指定角色`,
    `/profile off                 关闭角色，恢复默认`,
    ``,
    `当前 AI: ${activeAI === "cc" ? "Claude Code" : activeAI === "api" ? "Direct API" : "Codex"}`,
  ].join("\n"), ctx);
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// handleCC() —— 处理 /cc 命令，切换到 Claude Code 后端
// ═══════════════════════════════════════════════════════════════
// 输入：
//   userId - 用户微信 ID
//   ctx    - 微信上下文 token
// 输出：无（副作用：切换 AI 后端、保存状态、发送确认消息）
export async function handleCC(userId, ctx) {
  if (activeAI === "cc") { await sendMessage(userId, "⚠️ 当前已是 Claude Code", ctx); return; }
  setActiveAI("cc");
  saveSessions(); saveToken();
  await sendMessage(userId, `✅ 已切换到 Claude Code`, ctx);
}

// ═══════════════════════════════════════════════════════════════
// handleCodex() —— 处理 /codex 命令，切换到 Codex 后端
// ═══════════════════════════════════════════════════════════════
// 输入：
//   userId - 用户微信 ID
//   ctx    - 微信上下文 token
// 输出：无（副作用：切换 AI 后端、保存状态、发送确认消息）
export async function handleCodex(userId, ctx) {
  if (activeAI === "codex") { await sendMessage(userId, "⚠️ 当前已是 Codex", ctx); return; }
  setActiveAI("codex");
  saveSessions(); saveToken();
  await sendMessage(userId, `✅ 已切换到 Codex`, ctx);
}

// ═══════════════════════════════════════════════════════════════
// handleAPI() —— 处理 /api 命令，切换到 Direct API 后端
// ═══════════════════════════════════════════════════════════════
// 输入：
//   userId    - 用户微信 ID
//   ctx       - 微信上下文 token
//   messageAI - 当前活跃的 AI 后端标识（用于获取活跃会话）
// 输出：无（副作用：切换 AI 后端、加载历史上下文、发送确认消息）
export async function handleAPI(userId, ctx) {
  if (!isApiConfigured()) { await sendMessage(userId, "⚠️ API 未配置，请在 config.json 设置 api.baseUrl 和 api.apiKey", ctx); return; }
  if (activeAI === "api") { await sendMessage(userId, "⚠️ 当前已是 Direct API", ctx); return; }
  setActiveAI("api");
  saveSessions(); saveToken();
  // 初始化 API 上下文：从聊天历史中加载已有的消息
  const apiSess = activeSession(userId);
  if (apiSess && (!apiSess._apiMessages || apiSess._apiMessages.length === 0)) {
    const events = await loadAllEvents();
    const sessionEvents = events.filter(e => e.sessionId === apiSess.id && e.text?.trim()).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    apiSess._apiMessages = sessionEvents.map(e => ({
      role: e.role === "assistant" ? "assistant" : "user",
      content: e.text,
      _eventId: e.id,
    }));
  }
  const { model } = resolveApiConfig();
  await sendMessage(userId, `✅ 已切换到 Direct API\nModel: ${model}\n上下文: ${apiSess?._apiMessages?.length || 0} 条消息已加载`, ctx);
}

// ═══════════════════════════════════════════════════════════════
// handleNew() —— 处理 /new 命令，创建新的会话线程
// ═══════════════════════════════════════════════════════════════
// 支持 /new <name>、/new remote <name>、/new rp <name> 格式
// 输入：
//   userId    - 用户微信 ID
//   body      - 完整命令文本（如 "/new mychat"）
//   ctx       - 微信上下文 token
//   messageAI - 当前活跃的 AI 后端标识
// 输出：无（副作用：创建新会话、切换活跃会话、发送确认消息）
export async function handleNew(userId, body, ctx, messageAI) {
  const name = (body.slice(5).trim()) || nextSessionName(userId, messageAI);
  // 检查名称冲突
  if (hasSessionName(userId, name, null, messageAI)) {
    await sendMessage(userId, `⚠️ 线程名 "${name}" 已存在，请换一个名称`, ctx);
    return;
  }
  // 如果名称正好是已知角色模板名，自动绑定该角色
  const boundProfile = name === "默认" ? null : (profileTemplates[name] ? name : null);
  const u = ensureUser(userId, messageAI);
  const sess = makeSession(name, boundProfile);
  u.list.push(sess);
  u.activeId = sess.id;               // 新会话自动成为活跃会话
  saveSessions();
  await sendMessage(userId, `✅ 新线程: ${name}${boundProfile ? `\n角色: ${boundProfile}` : ""}`, ctx);
}

// ═══════════════════════════════════════════════════════════════
// handleSwitch() —— 处理 /switch 命令，切换活跃会话
// ═══════════════════════════════════════════════════════════════
// 无参数时显示会话列表，有参数时切换到指定会话
// 输入：
//   userId - 用户微信 ID
//   body   - 完整命令文本（如 "/switch 2" 或 "/switch mychat"）
//   ctx    - 微信上下文 token
// 输出：无（副作用：切换活跃会话、发送确认消息）
export async function handleSwitch(userId, body, ctx) {
  const key = body.slice(8).trim();
  if (!key) { await sendMessage(userId, `线程:\n${sessionsListText(userId)}`, ctx); return; } // 无参数时显示列表
  const sess = findSession(userId, key);
  if (!sess) { await sendMessage(userId, `⚠️ 未找到 "${key}"\n${sessionsListText(userId)}`, ctx); return; }
  ensureUser(userId).activeId = sess.id;  // 更新活跃会话 ID
  saveSessions();
  await sendMessage(userId, `✅ 已切换: ${sess.name}`, ctx);
}

// ═══════════════════════════════════════════════════════════════
// handleRename() —— 处理 /rename 命令，重命名会话
// ═══════════════════════════════════════════════════════════════
// 支持 /rename <新名称>（重命名当前线程）和 /rename [序号|名称] <新名称>（重命名指定线程）
// 输入：
//   userId    - 用户微信 ID
//   body      - 完整命令文本
//   ctx       - 微信上下文 token
//   messageAI - 当前活跃的 AI 后端标识
// 输出：无（副作用：重命名会话、发送确认消息）
export async function handleRename(userId, body, ctx, messageAI) {
  const rest = body.slice(8).trim();
  if (!rest) { await sendMessage(userId, "用法: /rename <新名称>  重命名当前线程\n/rename [序号|名称] <新名称>  重命名指定线程", ctx); return; }
  const tokens = rest.split(/\s+/);
  const first = tokens[0];
  const numIdx = /^\d+$/.test(first) ? Number(first) : 0;
  const u = ensureUser(userId, messageAI);
  // 判断第一个 token 是数字序号还是名称
  const isNumRef = Number.isInteger(numIdx) && numIdx >= 1 && numIdx <= u.list.length;
  const isNameRef = u.list.some(s => s.name === first || s.name.includes(first));
  let key, newName;
  if ((isNumRef || isNameRef) && tokens.length >= 2) {
    key = first;                          // 指定目标会话
    newName = tokens.slice(1).join(" ");   // 剩余部分为新名称
  } else {
    newName = rest;                       // 重命名当前会话
  }
  if (!newName) { await sendMessage(userId, "⚠️ 新名称不能为空", ctx); return; }
  let target;
  if (key) {
    target = findSession(userId, key);
    if (!target) { await sendMessage(userId, `⚠️ 未找到 "${key}"`, ctx); return; }
  } else {
    target = activeSession(userId);
  }
  // 检查新名称是否冲突（排除自身）
  if (hasSessionName(userId, newName, target.id, messageAI)) {
    await sendMessage(userId, `⚠️ 线程名 "${newName}" 已存在，重命名失败`, ctx);
    return;
  }
  target.name = newName;
  saveSessions();
  await sendMessage(userId, `✅ 已重命名: ${newName}`, ctx);
}

// ═══════════════════════════════════════════════════════════════
// handleSessions() —— 处理 /sessions 命令，列出所有会话
// ═══════════════════════════════════════════════════════════════
// 输入：
//   userId - 用户微信 ID
//   ctx    - 微信上下文 token
// 输出：无（副作用：发送会话列表消息）
export async function handleSessions(userId, ctx) {
  await sendMessage(userId, `线程 (${activeAI === "cc" ? "Claude Code" : activeAI === "api" ? "Direct API" : "Codex"}):\n${sessionsListText(userId)}`, ctx);
}

// ═══════════════════════════════════════════════════════════════
// handleProfile() —— 处理 /profile 命令，管理角色绑定
// ═══════════════════════════════════════════════════════════════
// 无参数：显示当前角色和可用角色模板列表
// /profile <名称>：切换到指定角色
// /profile off：关闭角色扮演，恢复默认
// 输入：
//   userId    - 用户微信 ID
//   body      - 完整命令文本
//   ctx       - 微信上下文 token
//   activeSess - 当前活跃的 session 对象（可选）
// 输出：无（副作用：切换角色、发送确认消息）
export async function handleProfile(userId, body, ctx) {
  const rest = body.slice(9).trim();

  if (!rest) {
    // 无参数：显示当前角色及所有可用角色模板列表
    const cur = sessionProfile(activeSession(userId));
    const list = Object.entries(profileTemplates)
      .map(([k, v]) => `${k === cur ? "→" : " "} ${k}: ${v.slice(0, 40)}...`)
      .join("\n");
    const aiLabel = activeAI === "cc" ? "Claude Code" : activeAI === "api" ? "Direct API" : "Codex";
    const sess = activeSession(userId);
    const current = [
      `AI: ${aiLabel}`,
      `线程: ${sess.name}`,
      `角色: ${cur || "默认"}`,
    ].join("\n");
    await sendMessage(userId, `${current}\n\n模板:\n${list}\n\n/profile 名字 切换\n/profile off 关闭`, ctx);
    return;
  }
  if (rest === "off" || rest === "关闭" || rest === "默认") {
    // 关闭角色 → 检查线程是否已绑定角色
    const sess = activeSession(userId);
    if (sess._profile) {
      await sendMessage(userId, `⚠️ 当前线程已绑定角色「${sess._profile}」，不能切回默认。\n请用 /new 默认 新建默认线程，或 /switch 切到其他默认线程。`, ctx);
      return;
    }
    await sendMessage(userId, `✅ 当前线程保持默认风格`, ctx);
    return;
  }
  // 检查角色模板是否存在
  if (!profileTemplates[rest]) {
    await sendMessage(userId, `⚠️ 未找到 "${rest}"。\n可用: ${Object.keys(profileTemplates).join(", ")}`, ctx);
    return;
  }
  // 切换角色 → 检查线程是否已绑定其他角色
  const sess = activeSession(userId);
  if (sess._profile && sess._profile !== rest) {
    await sendMessage(userId, `⚠️ 当前线程已绑定角色「${sess._profile}」，不能切换成「${rest}」。\n请先 /new ${rest} 新建线程，再 /profile ${rest}。`, ctx);
    return;
  }
  sess._profile = rest;               // 绑定角色到当前会话
  saveSessions();
  await sendMessage(userId, `✅ 当前线程已绑定角色: ${rest}${sess._firstTurn ? "" : "\n提示：这个线程已有历史上下文；如果仍有旧口吻残留，请用 /new " + rest + " 新开线程。"}`, ctx);
}

// ═══════════════════════════════════════════════════════════════
// handleClose() —— 处理 /close 命令，关闭指定会话
// ═══════════════════════════════════════════════════════════════
// 输入：
//   userId - 用户微信 ID
//   body   - 完整命令文本（如 "/close 2"）
//   ctx    - 微信上下文 token
// 输出：无（副作用：关闭会话、可能需要创建新会话、发送确认消息）
export async function handleClose(userId, body, ctx) {
  const key = body.slice(7).trim();
  const u = ensureUser(userId);
  let target;
  if (key) {
    target = findSession(userId, key);  // 按序号/名称查找
    if (!target) { await sendMessage(userId, `⚠️ 未找到 "${key}"`, ctx); return; }
  } else {
    target = activeSession(userId);    // 无参数时关闭当前会话
  }
  if (target.busy) { await sendMessage(userId, `⚠️ ${target.name} 正在运行，请等任务完成后再关闭`, ctx); return; }
  const clearedPending = clearPendingInput(userId);  // 清除该用户的待处理消息

  const targetIdx = u.list.indexOf(target);
  const closedName = target.name;
  target._closing = true;              // 标记为关闭中

  // 切换 activeId 后旧 session loop 会停止，因此不能留下一个等待“排空”的孤立队列。
  target.queue.length = 0;
  u.list.splice(targetIdx, 1);

  // 确保用户至少有一个会话
  let autoCreated = null;
  if (u.list.length === 0) {
    const newName = nextSessionName(userId);
    const newSess = makeSession(newName);
    u.list.push(newSess);
    u.activeId = newSess.id;
    autoCreated = newName;
  } else if (u.activeId === target.id) {
    // 如果关闭的是当前活跃会话，切换到前一个
    const prevIdx = Math.max(0, targetIdx - 1);
    u.activeId = u.list[Math.min(prevIdx, u.list.length - 1)].id;
  }
  saveSessions();

  const nowActive = u.list.find(s => s.id === u.activeId);
  const nowName = nowActive ? nowActive.name : "?";
  const parts = [`✅ 已关闭 ${closedName}`];
  if (autoCreated) parts.push(`已自动创建新线程: ${autoCreated}`);
  if (clearedPending) parts.push("已清除该线程的待处理附件");
  parts.push(`当前线程: ${nowName}`);
  await sendMessage(userId, parts.join("\n"), ctx);
}

// ═══════════════════════════════════════════════════════════════
// handleStatus() —— 处理 /status 命令，显示当前运行状态
// ═══════════════════════════════════════════════════════════════
// 输入：
//   userId - 用户微信 ID
//   ctx    - 微信上下文 token
// 输出：无（副作用：发送状态信息消息）
export async function handleStatus(userId, ctx) {
  const u = ensureUser(userId);
  const sess = activeSession(userId);
  const idx = u.list.indexOf(sess) + 1;
  const backendLabels = { cc: "CC", codex: "Codex", api: "API" };
  const backendCounts = Object.fromEntries(Object.entries(sessions).map(([backend, map]) => [
    backend,
    Array.from(map.values()).reduce((sum, user) => sum + user.list.length, 0),
  ]));
  const profile = sessionProfile(sess);
  const status = sess.busy ? "⏳ 运行中" : sess.queue.length ? `排队 ${sess.queue.length}` : "空闲";
  await sendMessage(userId, [
    `# 状态`,
    ``,
    `AI:     ${activeAI === "cc" ? "Claude Code" : activeAI === "api" ? "Direct API" : "Codex"}  (${modelNames[activeAI]})`,
    `会话:   [${idx}] ${sess.name}`,
    `角色:   ${profile || "默认"}`,
    `状态:   ${status}`,
    `SID:    ${sess.sid}`,
    ``,
    Object.keys(backendLabels).map(backend => `${backendLabels[backend]}: ${backendCounts[backend] || 0}`).join("  |  "),
  ].join("\n"), ctx);
}

// ═══════════════════════════════════════════════════════════════
// handleCancel() —— 处理 /cancel 命令，取消当前运行的任务
// ═══════════════════════════════════════════════════════════════
// 输入：
//   userId    - 用户微信 ID
//   body      - 完整命令文本（即 "/cancel"）
//   ctx       - 微信上下文 token
//   activeSess - 当前活跃的 session 对象
// 输出：无（副作用：终止 AI 子进程、清空消息队列、发送确认消息）
export async function handleCancel(userId, ctx, activeSess) {
  const sess = activeSess;
  const clearedPending = clearPendingInput(userId);          // 清除待处理消息
  if (!sess?.busy) {
    await sendMessage(userId, clearedPending ? "⏹️ 已清除待处理的附件消息" : "⚠️ 当前没有运行中的任务", ctx);
    return;
  }
  // 杀掉正在运行的 AI 子进程
  if (sess._lastProc) {
    killProc(sess._lastProc);
    sess._lastProc = null;
  }
  sess.queue.length = 0;                                     // 清空消息队列
  const prefix = replyPrefix(sess?.name || "S1", activeAI);
  await sendMessage(userId, `# ${prefix}\n⏹️ 正在取消...${clearedPending ? "\n已清除待处理的附件消息" : ""}`, ctx);
}
