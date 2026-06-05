# WeChat AI Bot 双层架构分析

## 整体架构概览

这个项目是一个**双层 Prompt Pipeline** 的微信 AI Bot：

```
微信消息到达
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│ 第一层：Hidden World Session（隐藏世界层）                │
│ 角色级 Claude session，生成世界连续性 + 内心活动           │
│ 输出 inner_scenelet / life_arcs / world_state_patch / ...      │
└────────────────────────┬────────────────────────────────┘
                         │ 注入为 sceneContext
                         ▼
┌─────────────────────────────────────────────────────────┐
│ 第二层：主回复 Prompt Pipeline（主回复层）                 │
│ 组装 memory + sceneContext + RAG + chatStyle + 用户消息    │
│ → Claude/Codex 流式生成 → splitSocialReply → 发送微信      │
└─────────────────────────────────────────────────────────┘
```

**关键原则**：Hidden World 以 **profile（角色）** 为单位持久化，一个角色一条世界线、一个 hidden-world sid。多个微信聊天线程共享同一个角色的世界状态。

---

## 第一层：Hidden World Session Pipeline

### 触发时机
`processTurn()` 中，当检测到 `isProfileChat === true`（即当前会话绑定了非"默认"的角色 profile），**先于主回复**运行：

```js
// bot.mjs:3400-3403
if (isProfileChat) {
  sceneletResult = await generateSceneletForTurn({ userId, sess, profile, userBody, memoryPrompt });
}
```

### 阶段 1 — System Prompt 组装

函数 `buildHiddenWorldSystemPrompt(profile)` (L2396-2438) 组装一个**角色级持久 session** 的 system prompt，内容包括：

| 层级 | 内容 | 来源 |
|------|------|------|
| 核心任务 | 7 项任务定义（生成 inner_scenelet、world_state_patch、life_arc_ops、proactive_candidates、daily_share_candidates、schedule_candidates、time_reasoning + continuity_warnings） | 代码常量 |
| 时间连续性硬规则 | 多轮对话不重复累计"被叫醒"、睡眠通勤时长必须可算通、用户纠正时间时优先修正 hidden world | 代码常量 |
| daily_share 来源类型 | 4 种来源：life_arc_related / ambient_observation / memory_resurfacing / pure_mood | 代码常量 |
| sceneletInstructions | 可编辑的生成指示 | `prompts.json` |
| lifeArcInstructions | 短期生活线的管理规则 | `prompts.json` |
| 角色 prompt | 完整角色人设模板 | `wechat-profiles.json` |
| 聊天写法参考 | chatStyle（降低 scenelet 的 AI 味） | `prompts.json` |

### 阶段 2 — Dynamic Context 组装（每轮）

函数 `buildHiddenWorldPrompt()` (L2440-2531) 组装每轮的 stdin body，按顺序注入：

```
1. 长期记忆 (memoryPrompt)
2. 当前时间 (双时区 JSON: 北京 + 东京)
3. 输入 JSON：
   - hidden_world_session: { sid, firstTurn, startedAt, lastUsedAt }
   - world_state: 结构化当前状态 { location, activity, awake_state, current_plan, open_threads, last_world_event_at }
   - active_life_arcs: 活跃生活线列表
   - pending_proactive_intents: 待处理的主动消息候选
   - recent_visible_context: 最近可见聊天窗口 (最近 N 轮)
   - user_message: 当前用户消息
4. 输出 JSON Schema 定义
```

### 阶段 3 — Hidden World 执行

函数 `generateSceneletForTurn()` (L2550-2619)：

```
1. getRoleWorld(profile) → 按 profile 取世界状态
2. ensureWorldSession(roleWorld) → 确保有 _worldSession { sid, firstTurn, model }
3. runHiddenJson(prompt, { persist: true, sessionName: "hidden-world-{profile}", sessionId: world.sid, firstTurn, systemPrompt })
   → 用 --session-id / --resume 保持同一个 Claude session
   → 如果 resume 失败（返回 null），重试一次，重置 sid
4. normalizeSceneletResult(raw) → 标准化输出字段
5. 写回状态：
   - world.sid = raw._hiddenCall.session_id
   - applyWorldStatePatch(roleWorld, worldStatePatch)
   - roleWorld._worldLastOutput = { 完整输出快照 }
   - syncRoleWorldToSession(sess, profile) → 同步到所有绑定的微信线程
   - saveRoleWorlds() → 持久化到 data/wechat-worlds.json
```

### 阶段 4 — 输出结构

Hidden World 每轮输出一个 JSON，核心字段：

| 字段 | 用途 | 消费者 |
|------|------|--------|
| `inner_scenelet` | 角色内心活动/此刻状态/情绪落点/接话方式 | 主回复 buildSceneContextBlock |
| `life_arc_ops` | 短期生活线操作 (create/update/close) | applyLifeArcOps → roleWorld |
| `world_state_patch` | 结构化当前位置/活动/清醒状态/计划 | applyWorldStatePatch → roleWorld |
| `proactive_candidates` | 一次性 follow_up / daily_share 候选 | addProactiveCandidates → session queue |
| `daily_share_candidates` | 每日分享候选（含 source_type） | 日志记录 + 后续判断 |
| `schedule_candidates` | 日程候选 | 日志记录 + 后续判断 |
| `time_reasoning` | 时间推理过程 | 日志审计 |
| `continuity_warnings` | 连续性警告 | 日志审计 |

### 阶段 5 — Independent Finalizers

在主回复完成后，程序调用独立判断器处理候选：

```
handleProactive() → 到点二次判断 follow_up / daily_share 是否真的发送
handleDailyShareSeed() → daily share seed 是否触发新候选
handleScheduleFinalization() → schedule candidates 是否升级为 life_arc
```

---

## 第二层：主回复 Prompt Pipeline

### 阶段 0 — 入站消息预处理

`processTurn()` (L3369) 的头部：

```
1. sessionProfile(styleState) → 确定当前绑定 profile
2. renderMemoryPrompt(userId, { profile }) → 读取记忆 snapshot
3. 创建日志流 (jsonl + txt)
```

### 阶段 1 — 稳定 System Context

不变的 system prompt 部分（通过 `--append-system-prompt-file` 注入）：

```
- Profile Template → 角色完整人设（仅非默认 profile）
- buildStableStylePrompt() → expressionCapability 表情能力约束
```

这部分是**可缓存的**，不随每轮用户消息变化。

### 阶段 2 — 主回复 Turn Body 组装

函数 `buildTurnBody()` (L1996-2016)，**按真实顺序**组装 stdin body：

```
┌─────────────────────────────────────────┐
│ 1. memoryPrompt      长期记忆 snapshot    │  ← 动态，随记忆增删变化
├─────────────────────────────────────────┤
│ 2. sceneContext      Hidden World 注入   │  ← 从 generateSceneletForTurn 来
│    ├─ life_arc 简述  最近 3 条 life_arc   │
│    ├─ inner_scenelet 角色内心活动         │
│    └─ bridge instr   桥接指示            │
├─────────────────────────────────────────┤
│ 3. RAG context       知识库检索结果       │  ← 仅命中触发条件时注入
├─────────────────────────────────────────┤
│ 4. CURRENT_SITE_AND_SEARCH_GUARD        │  ← 代码常量
├─────────────────────────────────────────┤
│ 5. chatStyle         聊天写法            │  ← prompts.json 可编辑
├─────────────────────────────────────────┤
│ 6. chatReality       聊天现实/双时区     │  ← 代码生成时间戳
├─────────────────────────────────────────┤
│ 7. userBody          用户消息            │  ← 带北京时间标记
└─────────────────────────────────────────┘
```

`buildSceneContextBlock()` (L2621-2650) 是将 hidden-world 输出**桥接**到主回复的关键函数，它把完整 JSON 压缩为：
- life_arc 简述（只传 title/current_state/next_useful_moment/kind/time_start/time_end，不传完整 JSON）
- inner_scenelet + bridge instruction（引导主回复如何使用 inside view）

### 阶段 3 — 主模型轮次

```
runClaudeStream / runCodexStream
  ├─ system prompt (稳定): profile + expressionCapability
  ├─ stdin body (动态): 上面组装的 turn body
  └─ 流式事件处理:
       ├─ assistant text → textBuf 缓冲
       ├─ tool_use → 记录工具使用
       ├─ flush() → 中途清空缓冲区发送
       └─ turn.completed/result → 最终 flush + splitSocialReply + sendMessage
```

flush 策略：
- 无 profile 聊天：300 字符或间隔 3s 触发 flush
- 有 profile 聊天：800 字符或工具调用触发 flush
- 最终回复：`splitSocialReply()` 按随机 burst 力度切分为自然聊天分段
- 每段通过 `splitText()` 强制不超过 `MAX_REPLY_LEN` (1800 bytes)

### 阶段 4 — 回复后持久化

仅**成功轮次**执行（L3719-3765）：

```
1. 更新 styleState 时间戳 + visibleHistory
2. applyLifeArcOps(roleWorld, lifeArcOps) → 写回 life_arcs
3. syncRoleWorldToSession → 同步到所有绑定线程
4. saveRoleWorlds() → 持久化
5. addProactiveCandidates → 主动消息候选入队
6. recordChatHistory() → 追加式聊天历史 (含 scenelet 信息)
7. updateUserMemoryFromTurn() → Memory Writer:
   ├─ 候选抽取 (fast model)
   └─ 合并规划 (add/update/noop)
8. memoryMaintenanceNotice → 条目/字符数超限提醒
```

---

## 两层之间的数据流向图

```
                  ┌─── Hidden World Session ───┐
                  │  profile 级持久 session     │
                  │  session-id: "hidden-world-  │
                  │             白鹭千圣"        │
                  │                             │
  入站消息 ──────►│  输入:                      │
  (每条微信消息)  │  - world_state              │
                  │  - life_arcs                │
                  │  - visible_context          │
                  │  - memory                   │
                  │  - user_message             │
                  │                             │
                  │  输出:                      │
                  │  - inner_scenelet ──────────┼───────┐
                  │  - life_arc_ops ────────────┼───┐   │
                  │  - world_state_patch        │   │   │
                  │  - proactive_candidates     │   │   │
                  │  - daily_share_candidates   │   │   │
                  │  - schedule_candidates      │   │   │
                  └─────────────────────────────┘   │   │
                                                     │   │
  ┌──────────────────────────────────────────────────┘   │
  │  ┌───────────────────────────────────────────────────┘
  │  │
  ▼  ▼
┌────── 主回复 Prompt Pipeline ──────────────────────────┐
│                                                        │
│  System Prompt (稳定缓存):                              │
│  - Profile Template                                    │
│  - Expression Capability                               │
│                                                        │
│  Turn Body (动态 stdin):                               │
│  ┌──────────────────────────────────────┐              │
│  │ memory snapshot                      │              │
│  │ life_arcs 简述                        │ ◄── HW 注入  │
│  │ inner_scenelet + bridge instruction  │ ◄── HW 注入  │
│  │ RAG context (按需)                    │              │
│  │ chatStyle + chatReality              │              │
│  │ 用户消息 + 北京时间                    │              │
│  └──────────────────────────────────────┘              │
│                                                        │
│  Claude/Codex 流式 → splitSocialReply → 微信发送        │
│                                                        │
│  ┌─ 回复后 ────────────────────────────┐               │
│  │ - 写回 life_arcs                    │               │
│  │ - recordChatHistory                 │               │
│  │ - Memory Writer                     │               │
│  │ - proactive/daily/schedule 判断器   │               │
│  └─────────────────────────────────────┘               │
└────────────────────────────────────────────────────────┘
```

---

## GUI 前端对应关系

前端有 **7 个标签页**，与两层架构的对应关系：

| 标签页 | 对应架构层 | 展示内容 |
|--------|-----------|---------|
| **Prompts** | 主回复 Pipeline | 完整 15 步 pipeline（0-4 阶段），可编辑 textFields/numFields/RAG 关键词 |
| **Hidden World** | Hidden World Pipeline | 10 步 pipeline（1-4 阶段），profile 级 session 快照，reset 编辑器 |
| **Status** | 会话管理 | session 列表 + resume 指令 + 在线状态 |
| **Proactive** | Hidden World 阶段 4 | intents 按 profile 分组，pending/sent/cancelled 状态 |
| **History** | 审计层 | 会话列表 + 消息列表 + scenelet 状态 + 搜索 |
| **Memory** | Memory 系统 | 按 userId/role/category 的记忆卡片 CRUD |
| **Config** | 配置 | 嵌套 JSON 表单 |

---

## 架构优化分析

### A. 架构优点

**A1. 关注点分离清晰。**
Hidden World 专注世界连续性（角色在哪、在做什么、什么心情），主回复专注用户可见输出。防止主模型需要在上下文中”记住”角色状态，避免角色一致性随对话增长而衰减。

**A2. 桥接层设计克制。**
`buildSceneContextBlock()` 对 hidden-world 输出做了有意义的信息压缩：life_arc 只传最近 3 条的简述而非完整 JSON，inner_scenelet 附带 bridge instruction 引导主回复如何使用。不会把 hidden world 的结构化元数据直接 dump 给主模型造成 token 浪费。

**A3. 缓存感知的 prompt 分层。**
System prompt（profile template + expressionCapability）走 `--append-system-prompt-file`，可缓存。Turn body（memory + sceneContext + RAG + 聊天写法 + 用户消息）走 stdin，每轮可变。符合 prompt caching 最佳实践。

**A4. 优雅降级。**
Hidden world 失败不阻断主回复——sceneletError 被记录但 processTurn 继续执行。主回复在没有 sceneContext 的情况下仍能生成回复。

**A5. 结构化输出契约。**
Hidden World 用严格 JSON schema 约束输出，`normalizeSceneletResult()` 做防御性解析（stripJsonFences + fallback substring 匹配），解析失败有日志。

### B. 需要关注的潜在问题

**B1. Memory 在两层中重复注入。**
`memoryPrompt` 既注入 hidden world（L2460），也注入主回复（L1999-2001）。如果记忆 store 有 2000+ 字符，每轮两层的 token 成本翻倍。
- 可能的优化：hidden world 在 inner_scenelet 中提炼与当前语境相关的记忆要点，主回复只接收这份提炼。风险是 hidden world 可能丢失关键记忆信息。
- **决定：接受此建议，保留在文档中作为远期优化项，暂时不改动代码。**

**B2. scene_state 已无存在必要。** `[已决定：删除 scene_state]`

架构演进背景：最初 scenelet 是一次性调用（每轮独立），scene_state 是轮次间传递信息的核心载体。现在有了稳定连续的 hidden world session（--resume），模型内部已有上下文记忆，scene_state 的原始职能已经过时。

当前 scene_state 的实际消费者：
1. `buildSceneContextBlock()` → 作为 “轻量 scene_state” 注入主回复 Turn Body → inner_scenelet 已经覆盖了同样的信息需求，不应额外维护一个压缩版
2. 下一轮 hidden world 的 `carriedSceneState` 参数 → 当前代码中已固定传空字符串 `””`（L2559），实际无消费者
3. 持久化到 `roleWorld._sceneState` 并同步到所有绑定 session → 纯冗余

**删除范围**：
- 后端：移除 `sceneStateText()`、`setSceneStateFromText()`、`normalizeSceneState()` 相关逻辑
- 后端：`buildSceneContextBlock()` 移除 scene_state 注入段落
- 后端：`buildHiddenWorldPrompt()` / `generateSceneletForTurn()` 移除 carriedSceneState 参数
- 后端：`recordChatHistory()` 移除 sceneState 字段（或保留但始终为空，向下兼容历史数据）
- 后端：hidden world 输出 schema 移除 `next_scene_state` 字段
- 后端：`roleWorld._sceneState` 清理，`syncRoleWorldToSession()` 移除相关同步
- 后端：`gui-world.mjs` 的 `safeWorld()` 移除 sceneState 字段
- GUI：Prompts 页阶段 2 移除 scene_state 相关说明
- GUI：Hidden World 页移除 scene_state 相关展示
- GUI：Reset 编辑器移除 sceneState 编辑栏
- 数据：`wechat-worlds.json` 清理 `_sceneState` 字段
- 数据：`prompts.json` 移除 `sceneStateIntro`、`sceneStateMaxChars` 等已无用的配置项

---


## GUI 优化方向

### C. 设计定位确认

GUI 的设计目标（经确认）：
- **不需要**实时改动 session 状态
- **需要**控制所有运行条件和参数（可编辑的 prompt、数值参数、RAG 关键词等）
- **需要**观察运行状态（session 列表、proactive intents、chat history 含 scenelet 等）
- 深度调试走后台日志（jsonl + txt），GUI 不承担全量调试职能

### D. 具体优化项

#### D1. Pipeline 页面解释性标签过于冗杂 `[采纳]`

目前两个 Pipeline 页面（Prompts 15 步、Hidden World 10 步）的 `renderPipelineMeta` 在每一步挂载了大量 `<span>` 标签。所有解释说明文字不需要以 meta-item 标签的形式呈现，直接在标题下用纯文本解释即可。

#### D2. 两个 Pipeline 页之间添加跳转链接 `[采纳]`

Prompts 页第 8 步 “Hidden-world 输出注入” 添加 “跳转到 Hidden World Pipeline →” 链接按钮。Hidden World 页也对应添加跳回 Prompts 页的链接。改动极小，信息架构收益大。

#### D3. Prompts 页第 15 步简化 + proactive/daily/schedule 参数迁移到 Hidden World 页 `[采纳]`

- Prompts 页阶段 4 的第 15 步 “Hidden-world 后续工序” 只保留一句总览描述 + “在 Hidden World 页配置 →” 跳转链接。
- 所有 proactive/daily/schedule 相关的可编辑参数（proactiveCheckIntervalMs、proactiveCooldownMs、proactiveDailyMax、dailyShareSeedIntervalMs、dailyShareMinIdleMs、scheduleCheckIntervalMs、scheduleMaxActive 等）从 Prompts 页移除，统一归到 Hidden World 页阶段 4 中编辑。
- 按功能分类，而非按文件分类。

#### D4. Hidden World 页移除 “当前 role-level session” 区块 `[采纳]`

整个阶段 2 的第 3 步 “当前 role-level session”（sid、model、firstTurn、lastUsedAt、Last Usage token 统计、Wechat Threads 表）不需要在 GUI 中常态展示。这些信息在出问题时查看日志即可。

#### D5. Reset 编辑器从 JSON 大框改为字段化表单 `[采纳]`

当前 Reset 编辑器中 worldState、lifeArcs、threadIntents、lastOutput 各是一个大 JSON textarea。改为每个字段单独带编辑栏的表单形式，更适合人类编辑。同时将 continuity_warnings 作为冷启动必要内容加入 Reset 编辑器（不需要常态展示，只需要可编辑）。

注意：sceneState 已随 B2 删除，不出现在 Reset 编辑器中。

#### D6. 两层架构保持分两个 Tab 管理 `[维持现状]`

不合并 Prompts 和 Hidden World 为单页双栏布局。保持两个独立 Tab，通过 D2 中的跳转链接建立关联即可。

#### D7. lifeArcInstructions 加入"偏向客观事实"指令 `[采纳]`

在 `lifeArcInstructions` 的 prompt 中加入明确指令：life_arc 描述客观事件和状态变化（日程、事件、活动），不记录对特定对话的情绪反应。情绪反应更适合留在 inner_scenelet 中（per-turn、per-thread）。仅改 prompts.json 默认值。

### E. 优化优先级排序

| 优先级 | 改动 | 说明 |
|--------|------|------|
| **P0** | B2 删除 scene_state（全链路） | 涉及 bot.mjs / reply.mjs / gui-world.mjs / app.js / wechat-worlds.json / prompts.json，范围最大但逻辑清晰 |
| **P0** | D1 Pipeline 精简解释性标签 | 影响两个页面整体可读性，优先做 |
| **P0** | D3 Prompts 第 15 步精简 + 参数迁移 | 消除编辑权责混淆，确立按功能分类的编辑原则 |
| **P1** | D4 Hidden World 移除 session 信息区块 | 纯删除操作，简单直接 |
| **P1** | D2 Pipeline 跨页跳转链接 | 改动小，导航价值高 |
| **P1** | D7 lifeArcInstructions 偏向客观事实 | 仅改 prompts.json 默认值 |
| **P2** | D5 Reset 编辑器字段化改造 | 涉及前端表单重构，工作量中等
