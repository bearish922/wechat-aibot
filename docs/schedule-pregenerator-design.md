# 日程预生成器设计文档

## 概述

**目标**：为角色（当前聚焦千圣）提供主动的、结构化的日程预生成能力，解决"模型在日程生成上过于被动"的问题。千圣作为童星出身、事业心强的现役艺人，有丰富的演艺工作（综艺、影视、媒体、巡演等），这些工作天然是展开话题的好素材，但纯靠模型从对话中提取会严重不足。

**核心设计原则**：
- 这是一个**通用角色框架**，不只服务于千圣一个角色
- 生成器独立于对话流程，不影响 Actor 的回复质量
- 日程密度保守优先，扩大容错空间，不必像剧情里那么忙
- 所有可调参数都暴露在配置层，后续可根据效果微调

---

## 一、架构定位

```
bot.mjs 主循环（每 20s tick）
  ├── proactive 检查（已有）
  ├── dailyShare seed 生成（已有）
  └── schedule 确认（已有）

独立 setInterval（schedule-pregenerator 专用，每 60s tick）
  └── 检查各角色是否需要触发生成
```

```
schedule-pregenerator（app/lib/work-event-generator.mjs）
  ├── 配置驱动：只有配置了 workEventConfig 的角色才启用
  ├── 角色独立：每个角色的素材池、密度、冲突策略独立
  ├── JSON 结构化池抽骨架 → 模型填血肉（混合方案）
  └── 直接写入 life_arcs：不经过 pending/scheduleCreator 确认流程
```

### 为什么直接写入而不走 schedule 确认流程

| 维度 | 直接写入 | schedule 确认流程 |
|---|---|---|
| 来源 | 系统按规则主动生成 | 从对话中提取的模糊候选项 |
| 质量 | 可控：骨架由 JSON 随机抽取 | 不可控：对话可能不精确 |
| 时效性 | 即时生效 | 受 `scheduleCheckIntervalMs`（24h）延迟 |
| 意义 | "提前播种"：让 Actor 在对话中自然感知 | "事后审核"：确认用户提到的事 |

两种路径服务于不同场景：确认流程适合"用户说下周六有约"这类从对话提取的不确定信息；预生成器适合"系统主动安排千圣下周录综艺"这类已知合理的事件。两套独立运行，互不干扰。

### 为什么用独立 setInterval 而非钩入主循环

| 维度 | 钩入主循环（方案 A） | 独立 setInterval（方案 B，采纳） |
|---|---|---|
| 职责分离 | 主循环逐渐变重，生成器检查与 proactive 等混在一起 | 生成器是独立后台任务，语义清晰 |
| 阻塞风险 | 生成器 AI 调用（5-15 秒）阻塞同 tick 的其他检查 | 不影响主循环的 proactive / schedule 检查 |
| tick 间隔 | 跟随主循环 20s，大部分 tick 浪费在无效检查上 | 自定义间隔（60s），减少无效检查 |
| 错误隔离 | 生成器异常可能污染主循环状态 | 独立 try-catch，错误不影响主循环 |
| 复杂度 | 少一个 timer | 多一个 timer + 防并发标志位（`isRunning`） |

方案 B 胜在职责清晰、不影响现有逻辑。新增的"防止上一次生成还在跑时下一次 tick 再次触发"逻辑，用一个 `isRunning` 布尔标志位即可解决。

### 并发写入策略

预生成器和 continuity update（`finalizeTurnSuccess`）同时操作 `_lifeArcs`，存在 read-modify-write 竞争。不加锁——改为队列化：

预生成器在模型返回后，先用最新 `life_arcs` 做第二次冲突校验；校验通过后，在不包含 `await` 的临界段中直接执行 `applyLifeArcOps` + `saveRoleWorlds()`。因此即使该角色当前不是 active 会话，生成结果也会立即生效。

```
预生成器 setInterval
  └── 生成完成 → 按最新 life_arcs 二次校验 → 原子写入

bot.mjs 主循环 tick
  └── continuity update → applyLifeArcOps(life_arc_updates)
  └── 后续对话直接读取已经落盘的 generated events
  └── saveRoleWorlds()
```

零额外同步开销，自然序列化。

---

## 二、密度模型

### 2.1 基础定义

**密度** = 事件占用的实际工时 / 一天可工作时间。

**一天可工作时间上限** = `workHoursPerDay`（默认为 8 小时）。

这个 8h 已经适度去掉了吃饭、通勤、洗漱等日常缓冲——它既是密度计算的分母，也是当天工时的天花板。

```
density = duration_hours / workHoursPerDay
当天 sum(density) ≤ 1.0
```

`workHoursPerDay` 是唯一控制密度的可配置参数。收窄 → 调低；放宽 → 调高。

以 `workHoursPerDay = 8` 为例：

| 场景 | 实际工时 | 密度和 | 判断 |
|---|---|---|---|
| 一个 6h 综艺 | 6h | 0.75 | 通过，当天只此一个工作 |
| 4h 采访 + 2h 会议 | 6h | 0.75 | 通过，两个工作排满 |
| 6h 综艺 + 3h 电台 | 9h | 1.125 | 拒绝，超出一天可用时间 |
| 8h 拍摄 | 8h | 1.0 | 刚好通过，但当天不能再塞任何工作 |

> 6h 综艺 + 3h 电台 = 9h 实际工时，勤奋的人并非做不到。当前从保守出发用 8h 卡住，后续如需放松，调高 `workHoursPerDay` 即可——无需改代码。

### 2.2 量级自动分类

量级（`scale`）不从模板中手工标注，而是根据以下规则自动计算：

| 量级 | 条件 | 密度范围（8h基准） | 说明 |
|---|---|---|---|
| `light` | `duration_hours ≤ 3` ∧ `duration_days == 1` | < 0.4 | 半天以内，如采访、试镜、课程 |
| `medium` | `duration_hours` 4-7 ∧ `duration_days == 1` | 0.4-0.85 | 半天到一天，如综艺、录音、粉丝会 |
| `heavy` | `duration_hours ≥ 8` ∨ `duration_days > 1` | ≥ 0.9 | 全天或跨天，如拍摄、巡演 |

实际密度按 `duration_hours / workHoursPerDay` 精确计算，不用取整或离散化。

---

## 三、冲突检测

两层机制，一个可配置参数 `workHoursPerDay`（默认 8）。

### 3.0 前提：life_arc 的时间锚点

当前 life_arc 的 `timeStart`/`timeEnd` 是**日期级**的（学期跨度几个月，生日覆盖一整天），无法直接用于小时级冲突检测。真正的时间信息散落在 `summary` 的非结构化文本中。

**解决方案**：给 life_arc 增加可选的结构化 `time_slots` 字段。

```json
// 课表 life_arc（追加 time_slots）
{
  "kind": "school",
  "timeStart": "2026-04-01T00:00:00+09:00",
  "timeEnd": "2026-07-31T23:59:59+09:00",
  "time_slots": [
    { "dayOfWeek": 1, "start": "09:10", "end": "10:40" },
    { "dayOfWeek": 1, "start": "10:50", "end": "12:20" },
    { "dayOfWeek": 2, "start": "10:30", "end": "12:00" }
  ]
}

// 伊芙生日庆典（如果确定了具体时间）
{
  "kind": "special_date",
  "timeStart": "2026-06-27T00:00:00+09:00",
  "timeEnd": "2026-06-27T23:59:59+09:00",
  "time_slots": [
    { "date": "2026-06-27", "start": "18:00", "end": "21:00" }
  ]
}
```

`time_slots` 支持两种锚定方式：
- `dayOfWeek` + `start`/`end`：每周周期性时间段（课程、定期排练等）
- `date` + `start`/`end`：特定日期的具体时间段（一次性活动）

字段为**可选**。没有 `time_slots` 的 life_arc 不参与硬检测，只触发软提示（见 3.3）。

`time_slots` 的另一价值：让模型在做时间判断时可以直接读取结构化时间数据，无需从 `summary` 中猜测。

### Level 1 — 硬时间重叠检测（代码层）

遍历所有**有 `time_slots` 的 active life_arcs** + 已预生成的工作事件，与候选事件的 time_range 做重叠检测。重叠 → 拒绝。

检测范围不限于 `kind: "school"`——任何有 `time_slots` 的 life_arc（课程、特殊日期活动、已有工作安排等）都参与。

```
已有 life_arc（伊芙生日庆典）：
  time_slots: [{ date: "2026-06-27", start: "18:00", end: "21:00" }]
候选：6/27 18:00-22:00 综艺录制 → 拒绝（与庆典时间重叠）
候选：6/27 10:00-14:00 杂志采访 → 通过（时间不重叠，进入 Level 2）
候选：6/28 全天拍摄 → 通过（日期不同，进入 Level 2）
```

### Level 2 — 工时上限检查（代码层）

当天所有事件的密度之和 ≤ 1.0（即实际工时 ≤ `workHoursPerDay`）。

计算方式：遍历当天所有 active life_arcs（有 `duration_hours` 的）+ 候选事件，将它们的 `duration_hours / workHoursPerDay` 累加。超过 1.0 → 拒绝。

代码只在这两层做硬防护。不重叠 + 不超工时 = 安排合理。角色是否觉得累、是否需要休息，由 Actor 在对话中自然反应（scenelet 里表达），不由预生成器预设。

### 3.3 软提示：日期级 life_arc 的回避

对于有 `timeStart`/`timeEnd` 但**没有** `time_slots` 的 life_arc（如伊芙生日细节未定），在生成 prompt 中注入轻量提示：

> 注意：以下日期有已安排的事项（具体时间未定），尽量避免安排全天工作或在该日期留出弹性。若无法完全避开，在 progress_note 中注明需要协调。
> - 2026-06-27：伊芙的生日（special_date）

一旦相关 life_arc 补充了 `time_slots`，自动升级为 Level 1 硬检测。

### 3.4 量级与冲突策略

| 量级 | 允许与有 time_slots 的 life_arc 冲突 | 逻辑 |
|---|---|---|
| `light` | 否 | 小工作应避开已有安排 |
| `medium` | 否 | 常规工作以已有安排优先 |
| `heavy` | `kind: "school"` 允许，其他否 | 拍摄/巡演可请假；但与特殊日期（生日、纪念日等）冲突仍拒绝 |

排练（非结构化、非固定时间）不进入 time_slots，由模型自由发挥，不在冲突检测中硬编码。

### 3.5 冲突策略的配置化

```json
"conflictPolicy": {
  "light": { "allow": false },
  "medium": { "allow": false },
  "heavy": { "allow": "school_only" },
  "minGapBetweenEventsMinutes": 60
}
```

类型统一为对象结构，避免 JS 中字符串被 truthy 误判。`allow` 取值：
- `false`：不允许与任何有 time_slots 的 life_arc 时间冲突
- `"school_only"`：只允许与 school 类型冲突（默认，适合学生艺人角色）
- `true`：允许与所有类型冲突（适合全职艺人角色）

其他角色（如普通学生）可全部设为 `false`，heavy 工作不存在。

---

## 四、参数体系

### 4.1 顶层结构（per-role，放在 prompts.json 的 roles.<角色名> 下）

```json
{
  "roles": {
    "白鹭千圣": {
      "workEventConfig": {
        "enabled": true,
        "workHoursPerDay": 8,
        "generationIntervalMs": 43200000,
        "maxEventsPerGeneration": 1,
        "minLeadHours": { "light": 24, "medium": 48, "heavy": 72 },
        "conflictPolicy": {
          "light": { "allow": false },
          "medium": { "allow": false },
          "heavy": { "allow": "school_only" },
          "minGapBetweenEventsMinutes": 60
        }
      },
      "workEventPrompt": "...",
      "workEventTemplates": [ ... ]
    }
  }
}
```

### 4.2 参数说明

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | bool | — | 角色是否启用预生成 |
| `workHoursPerDay` | number | `8` | 一天可工作小时数（已去缓冲），密度计算基准 + 当天工时天花板 |
| `generationIntervalMs` | number | `43200000`（12h） | 生成间隔。每天检查 2 次，配合密度模型自然限流，避免填满后大量空跑 |
| `maxEventsPerGeneration` | number | `1` | 单次最多生成条数 |
| `minLeadHours` | object | `{light:24, medium:48, heavy:72}` | 各量级最小提前期（小时） |
| `conflictPolicy.{scale}.allow` | object | — | 各量级是否允许与已有 time_slots 冲突（`false` / `"school_only"` / `true`） |
| `conflictPolicy.minGapBetweenEventsMinutes` | number | `60` | 事件之间最小间隔（通勤/缓冲） |
| `workEventPrompt` | string | — | 生成指令 prompt |
| `workEventTemplates` | array | — | JSON 结构化素材模板池 |

### 4.3 最小提前期

| 量级 | 最小提前期 | 理由 |
|---|---|---|
| `light` | 24h（至少明天） | 短期安排 |
| `medium` | 48h | 需要一定准备时间 |
| `heavy` | 72h+ | 拍摄/巡演至少提前几天知道 |
| （巡演等大型 heavy） | 可更长（如 7 天+） | 在生成 prompt 中描述，不硬编码在参数中 |

**核心原则：不生成当天日程。** 当天日程只能来自对话中的实时决定（或已有的 life_arc），系统预生成永远面向明天及以后。

**窗口约束**：事件的 `start` 必须在 `[now + minLeadHours, now + 7天]` 区间内，但 `end` 可超出窗口上限——多日事件（如 5 天巡演）的结束时间不受 7 天窗口限制。代码层仅校验 start 是否在窗口内。

---

## 五、素材池：混合方案

**决策**：JSON 结构化池提供骨架（保证多样性），模型填充血肉（保证丰富性）。这个选择建立在 scenelet prompt 已有丰富素材池但模型并未充分展开的实际经验上——纯 prompt 不能保证多样性。

### 5.1 为什么不用纯 Prompt

scenelet prompt 里已经放了丰富的生活感素材池（具体到品牌、价格、地点），实际效果并不充分。模型有默认偏好，会倾向某些安全选项而忽略其他素材。同理，如果日程素材池只是 prompt 中的自然语言，模型可能在多次生成中反复输出"综艺录制"而完全不碰"舞台剧"或"试镜"。

### 5.2 模板结构

每个模板是一条 JSON，只定义骨架：

```json
{
  "type": "工作大类",
  "subtype": "细分类型",
  "duration_hours": 6,
  "duration_days": 1,
  "location_scope": "东京",
  "weight": 1.0,
  "repeatable": false,
  "note": "供模型参考的附加说明"
}
```

| 字段 | 说明 |
|---|---|
| `type` | 工作大类（综艺录制 / 电视剧拍摄 / ...） |
| `subtype` | 细分类型，用于冷却去重 |
| `duration_hours` | 单个工作日的实际工时 |
| `duration_days` | 持续天数。当天完成 = 1，跨天 = 实际天数 |
| `location_scope` | 地点范围（东京 / 关东 / 关西 / 京都 / 全国 等） |
| `weight` | 随机抽取权重，默认 1.0。低频事件设 0.1-0.8，条件触发事件设 0（退出随机池） |
| `repeatable` | 是否跳过冷却窗口子类型去重。默认 `false`。排练、课程等有意短期重复的事件设 `true` |
| `note` | 附加说明，注入 prompt 帮助模型生成细节 |

**量级和密度不存储在模板中**——从 `duration_hours / workHoursPerDay` 自动计算，`duration_days > 1` 自动判定为 heavy。

### 5.3 条件触发机制

`weight: 0` 的模板不进入随机池。代码层在每次生成前检查各条件触发模板的前置条件：

| 模板 | 前置条件 | 检查范围 |
|---|---|---|
| 全国巡演 | `kind: "work"` 且 `subtype` 含 `CD录制` 或 `MV拍摄` | 近 45 天内的 active/closed life_arcs |

条件满足时，该模板临时获得 `weight: 1.0` 注入本次随机池；不满足时跳过。

> 当前只定义了巡演的条件触发。后续如有明确的因果链工作类型可追加规则。

### 5.4 千圣模板池

```json
[
  // ══════════════════════════════════════════
  // 综艺录制（4 条）
  // ══════════════════════════════════════════
  { "type": "综艺录制", "subtype": "固定番组（趣味综艺TV）", "duration_hours": 6, "duration_days": 1, "location_scope": "东京", "weight": 1.0, "note": "PasPale全员参与的网络独播节目，通常下午录制" },
  { "type": "综艺录制", "subtype": "美食探店/旅行外景", "duration_hours": 7, "duration_days": 1, "location_scope": "关东", "weight": 1.0, "note": "外景为主，可能出差到关西等地" },
  { "type": "综艺录制", "subtype": "谈话/访谈节目", "duration_hours": 4, "duration_days": 1, "location_scope": "东京", "weight": 1.0, "note": "单人嘉宾或多组嘉宾对谈，电视台摄影棚" },
  { "type": "综艺录制", "subtype": "心理测试/趣味问答/整蛊企划", "duration_hours": 6, "duration_days": 1, "location_scope": "东京", "weight": 1.0, "note": "娱乐向综艺，可能有惩罚游戏等环节" },

  // ══════════════════════════════════════════
  // 电视剧拍摄（3 条）
  // ══════════════════════════════════════════
  { "type": "电视剧拍摄", "subtype": "连ドラ（现代剧）", "duration_hours": 8, "duration_days": 3, "location_scope": "东京", "weight": 1.0, "note": "连续剧拍摄，现代题材。需协调大学课程请假" },
  { "type": "电视剧拍摄", "subtype": "连ドラ（时代剧）", "duration_hours": 9, "duration_days": 4, "location_scope": "京都", "weight": 0.7, "note": "京都太秦/松竹摄影所，或茨城ワープステーション江戸等。需住宿+课程请假" },
  { "type": "电视剧拍摄", "subtype": "单发SP剧", "duration_hours": 8, "duration_days": 2, "location_scope": "东京", "weight": 0.8, "note": "单集特别剧，拍摄周期较短" },

  // ══════════════════════════════════════════
  // 电影拍摄（2 条）
  // ══════════════════════════════════════════
  { "type": "电影拍摄", "subtype": "现代剧", "duration_hours": 8, "duration_days": 4, "location_scope": "东京", "weight": 0.5, "note": "东京都内取景为主" },
  { "type": "电影拍摄", "subtype": "时代剧", "duration_hours": 9, "duration_days": 5, "location_scope": "京都", "weight": 0.3, "note": "京都太秦/松竹摄影所，或日光江户村、山形庄内电影村等大型时代剧オープンセット。需住宿+课程请假" },

  // ══════════════════════════════════════════
  // 舞台/演剧（4 条）
  // ══════════════════════════════════════════
  { "type": "舞台剧排练", "subtype": "商业舞台", "duration_hours": 7, "duration_days": 1, "location_scope": "东京", "weight": 1.0, "repeatable": true, "note": "租用都内排练场，全日稽古，含走位和部分通し稽古。在 progress_note 中暗示公演预计时间（通常排练开始后 3-6 周正式公演）" },
  { "type": "舞台剧排练", "subtype": "小剧场/实验剧", "duration_hours": 5, "duration_days": 1, "location_scope": "东京", "weight": 0.8, "repeatable": true, "note": "下北泽或高円寺小剧场，排练周期和强度相对宽松。在 progress_note 中暗示公演预计时间（小剧场通常排练到公演间隔较短）" },
  { "type": "舞台剧公演", "subtype": "商业舞台（东京公演）", "duration_hours": 8, "duration_days": 7, "location_scope": "东京", "weight": 0.6, "note": "每日1-2场公演，含周末昼夜。需课程请假" },
  { "type": "舞台剧公演", "subtype": "地方巡演", "duration_hours": 8, "duration_days": 5, "location_scope": "全国", "weight": 0.5, "note": "大阪/名古屋/福冈等地剧场。外地住宿，需课程请假" },

  // ══════════════════════════════════════════
  // 音乐节目（2 条）
  // ══════════════════════════════════════════
  { "type": "音乐节目出演", "subtype": "地上波音番（Mステ/CDTV等）", "duration_hours": 5, "duration_days": 1, "location_scope": "东京", "weight": 1.0, "note": "下午リハーサル+晚间生放送。PasPale新曲披露或与其他艺人共演" },
  { "type": "音乐节目出演", "subtype": "深夜音番/NHK歌番", "duration_hours": 4, "duration_days": 1, "location_scope": "东京", "weight": 1.0, "note": "收録制音番，午后彩排傍晚正式收録。NHKホール或テレ朝等。深夜时段事件允许例外于工作时间带约束" },

  // ══════════════════════════════════════════
  // 声优/配音（2 条）
  // ══════════════════════════════════════════
  { "type": "声优出演", "subtype": "电视动画/剧场动画", "duration_hours": 4, "duration_days": 1, "location_scope": "东京", "weight": 0.7, "note": "アフレコ收録，通常半天到一天。系列作可能有複数回收録" },
  { "type": "声优出演", "subtype": "游戏/吹替/ナレーション", "duration_hours": 3, "duration_days": 1, "location_scope": "东京", "weight": 0.5, "note": "游戏角色配音、洋画吹替或纪录片旁白收録，スタジオ单间录制" },

  // ══════════════════════════════════════════
  // 宣传巡回（2 条）
  // ══════════════════════════════════════════
  { "type": "宣传巡回", "subtype": "都内宣番（新剧/新曲/电影）", "duration_hours": 6, "duration_days": 1, "location_scope": "东京", "weight": 1.0, "note": "一日跑多个媒体：晨间情报番组+午间广播+傍晚杂志采访。经纪人陪同移动" },
  { "type": "宣传巡回", "subtype": "地方宣番", "duration_hours": 7, "duration_days": 2, "location_scope": "关西", "weight": 0.7, "note": "大阪/名古屋地方台和新媒体宣传，含新干线移动和当地媒体采访" },

  // ══════════════════════════════════════════
  // 直播/配信（2 条）
  // ══════════════════════════════════════════
  { "type": "直播/配信活动", "subtype": "YouTube/ニコ生/インスタライブ", "duration_hours": 2, "duration_days": 1, "location_scope": "东京", "weight": 1.0, "note": "企画配信，可能是新曲发售纪念、粉丝问答或与共演者的トーク配信。スタジオ或自宅均可" },
  { "type": "直播/配信活动", "subtype": "线上粉丝见面会", "duration_hours": 3, "duration_days": 1, "location_scope": "东京", "weight": 0.8, "note": "付费线上配信，含迷你live和问答环节，通常配信スタジオ举行" },

  // ══════════════════════════════════════════
  // 广告/平面（4 条）
  // ══════════════════════════════════════════
  { "type": "CM广告拍摄", "subtype": "品牌代言", "duration_hours": 5, "duration_days": 1, "location_scope": "东京", "weight": 1.0, "note": "单日拍摄，化妆品/食品/服装品牌等" },
  { "type": "杂志采访/写真", "subtype": "偶像杂志/时尚杂志", "duration_hours": 4, "duration_days": 1, "location_scope": "东京", "weight": 1.0, "note": "含采访+写真拍摄，摄影棚或外景" },
  { "type": "写真集拍摄", "subtype": "ソロ写真集", "duration_hours": 8, "duration_days": 3, "location_scope": "全国", "weight": 0.1, "note": "重大节点项目。多地点ロケ（都内+冲绳/北海道等）。含花絮取材，需课程请假" },
  { "type": "写真集拍摄", "subtype": "グループ/メンバー合同", "duration_hours": 7, "duration_days": 2, "location_scope": "关东", "weight": 0.4, "note": "PasPale全体或小分组写真集，关东近郊ロケ" },

  // ══════════════════════════════════════════
  // 幕后/準備（3 条，repeatable）
  // ══════════════════════════════════════════
  { "type": "台本読み合わせ", "subtype": "电视剧/电影/舞台", "duration_hours": 3, "duration_days": 1, "location_scope": "东京", "weight": 1.0, "repeatable": true, "note": "制作公司或租用会议室，主创团队围读剧本。在 progress_note 中暗示后续安排：电视剧/电影通常读本后 1-3 周内撮入り，舞台则进入排练期" },
  { "type": "衣装合わせ", "subtype": "新剧/新曲/CM向け", "duration_hours": 2, "duration_days": 1, "location_scope": "东京", "weight": 1.0, "repeatable": true, "note": "造型师スタジオ，试穿和调整服装造型，可能含メイクテスト。通常意味着拍摄或公演已临近" },
  { "type": "振り付け練習", "subtype": "新曲/ツアー向け", "duration_hours": 4, "duration_days": 1, "location_scope": "东京", "weight": 1.0, "repeatable": true, "note": "租用舞蹈排练房，跟振付師学新曲编排。在 progress_note 中暗示本番时间（音番出演/ツアー初日/ MV拍摄等）" },

  // ══════════════════════════════════════════
  // 音乐/录音（2 条）
  // ══════════════════════════════════════════
  { "type": "CD录制", "subtype": "PasPale新单曲/专辑", "duration_hours": 7, "duration_days": 1, "location_scope": "东京", "weight": 1.0, "note": "录音棚录制，通常持续一整个白天。在 progress_note 中暗示发行窗口和后续宣番/ MV拍摄等安排" },
  { "type": "MV拍摄", "subtype": "PasPale", "duration_hours": 8, "duration_days": 1, "location_scope": "关东", "weight": 1.0, "note": "可能在外景（横滨等）或摄影棚拍摄。在 progress_note 中暗示发行时机和后续宣传计划" },

  // ══════════════════════════════════════════
  // 粉丝/活动（6 条）
  // ══════════════════════════════════════════
  { "type": "粉丝见面会", "subtype": "PasPale握手会/签名会", "duration_hours": 6, "duration_days": 1, "location_scope": "东京", "weight": 1.0, "note": "活动会场或CD店举行，通常半天到一天" },
  { "type": "PasPale巡演", "subtype": "全国ツアー", "duration_hours": 9, "duration_days": 5, "location_scope": "全国", "weight": 0, "note": "条件触发：近 45 天内存在 CD录制 或 MV拍摄 的 life_arc 时才注入随机池。东京/大阪/名古屋/札幌/福冈等。每站1-2场，跨城新干线移动，外地住宿。需课程请假" },
  { "type": "户外音乐节", "subtype": "フェス出演", "duration_hours": 10, "duration_days": 1, "location_scope": "全国", "weight": 0.3, "note": "夏季音乐节季（6-9月），可能在外地，当天往返或住一晚" },
  { "type": "颁奖典礼", "subtype": "音乐/影视奖项", "duration_hours": 5, "duration_days": 1, "location_scope": "东京", "weight": 0.2, "note": "如日本レコード大賞、日本アカデミー賞等。レッドカーペット+受賞/プレゼンター+会后采访" },
  { "type": "跨界联动活动", "subtype": "动画/游戏/品牌コラボ", "duration_hours": 6, "duration_days": 1, "location_scope": "东京", "weight": 0.7, "note": "某IP与PasPale的联动线下活动，含トークショー和ミニライブ" },
  { "type": "ファッションイベント", "subtype": "TGC/ガルコレ等", "duration_hours": 6, "duration_days": 1, "location_scope": "东京", "weight": 0.4, "note": "大型时尚秀出演。ランウェイ+トーク+バックステージ取材" },

  // ══════════════════════════════════════════
  // 培训/业务（3 条）
  // ══════════════════════════════════════════
  { "type": "试镜", "subtype": "电视剧/电影/舞台新角色", "duration_hours": 3, "duration_days": 1, "location_scope": "东京", "weight": 1.0, "note": "经纪公司安排的新角色试镜，含等候和面试时间" },
  { "type": "声乐/舞蹈/演技课程", "subtype": "艺人培训", "duration_hours": 3, "duration_days": 1, "location_scope": "东京", "weight": 1.0, "repeatable": true, "note": "经纪公司安排或自主报名的定期课程" },
  { "type": "经纪公司会议", "subtype": "定期例会/企画会議", "duration_hours": 2, "duration_days": 1, "location_scope": "东京", "weight": 1.0, "repeatable": true, "note": "与经纪人讨论接下来的工作安排，或与制作人/导演的企画打ち合わせ" },

  // ══════════════════════════════════════════
  // 写作/媒体（1 条）
  // ══════════════════════════════════════════
  { "type": "网络专栏", "subtype": "连载执笔", "duration_hours": 2, "duration_days": 1, "location_scope": "东京", "weight": 1.0, "note": "长期项目，定期更新。可以在家完成" }
]
```

共 40 条模板，覆盖 14 个大类。新增类别为：舞台/演剧、音乐节目、声优/配音、宣传巡回、直播/配信、写真集、幕后/準備、イベント（颁奖典礼/跨界联动/时尚秀）。

**冷却机制**：代码层维护近期已抽取的 template index 滑动窗口（最近 5 条），同 `subtype` 不连续出现。`repeatable: true` 的模板跳过冷却检查。冷却窗口持久化到 `_lastGenerationTemplateIndices`，随 `saveRoleWorlds()` 存储，重启不丢失。

### 5.5 混合流程

```
Step A — 代码层随机抽取
  从 workEventTemplates 中按 weight 加权随机选一个：
  - weight: 0 的模板不进入随机池（条件触发模板，见 5.5）
  - 避开冷却窗口中的 subtype（repeatable: true 的模板跳过此检查）
  - 其余模板按 weight 加权随机

Step B — 注入 prompt
  将模板 JSON + 角色上下文 + 已有日程注入 workEventPrompt

Step C — 模型填血肉
  模型在模板框架内生成：
  - life_arc 的 title（如「趣味综艺TV 第34期录制」）
  - summary（如「主题：春季甜品巡礼对决。共演：濑田薰。六本木电视台第3摄影棚」）
  - time_start / time_end（在模板时长约束内，避开已有日程）
  - progress_note（初始准备状态，如「台本已收到，明天和制作人确认流程」）
  - 具体情境 nuance（共演者状态、路上见闻等可在后续对话中展开的细节）
```

**模型自由度边界**：
- 必须遵守：模板的 `type` / `subtype` / `duration_hours` / `duration_days` / `location_scope`
- 自由发挥：具体主题、合作者、地点名、节目期数、当前进度、情境细节
- 允许返回空：如果模型判断不适合生成（如近期密度已满），返回 `{ events: [], reason: "..." }`

---

## 六、生成流程

### 6.1 承载与触发

**承载**：`app/lib/work-event-generator.mjs` 独立模块。

**触发**：方案 B — 独立 `setInterval`，在 `bot.mjs` 启动时注册。

```
bot.mjs 启动
  ├── workEventGenerator.runAll()（立即检查一次）
  └── setInterval(() => workEventGenerator.runAll(), 60000)
```

**触发条件**（`runAll` 内部对每个启用角色逐一判断）：
1. 每次 tick 动态读取 `workEventConfig.enabled === true`；启动时没有启用角色也照常注册 timer
2. 距离上次生成 ≥ `generationIntervalMs`（首次运行为 true）
3. 非 `isRunning` 状态（防止并发）
4. 角色 worldState 不作限制（允许角色睡眠时生成未来日程）

**并发控制**：
```javascript
let isRunning = false;
async function runAll() {
  if (isRunning) return;
  isRunning = true;
  try {
    for (const profile of enabledProfiles()) {
      await runForProfile(profile);
    }
  } finally {
    isRunning = false;
  }
}
```

### 6.2 生成步骤

```
Step 1 — 收集上下文
  - 当前东京时间（Asia/Tokyo）
  - 已有 active life_arcs（完整数据：kind、time_start、time_end、time_slots、progress_note）
  - 有时间锚点的 life_arcs：提取所有含 `time_slots` 的条目，解析为具体的日期+时间段
  - 日期级 life_arcs（有 timeStart/timeEnd 但无 time_slots）：用于软提示
  - 已有工作事件的 progress_note 摘要：注入 prompt 避免跨事件进度矛盾
  - worldState（角色当前位置等）
  - 冷却窗口：从 `_lastGenerationTemplateIndices` 读取（持久化，重启不丢失）

Step 2 — 随机抽取模板
  - 过滤掉冷却窗口中的 subtype
  - 随机抽取 1 个模板
  - 记录到冷却窗口

Step 3 — 计算 scale 和 density
  - scale = auto-classify(duration_hours, duration_days)
  - density = duration_hours / workHoursPerDay

Step 4 — 时间窗口计算
  - 最早开始：now + minLeadHours[scale]
  - 最晚开始：now + 7 天（太远的不生成，留给后续）
  - 标记已有日程占用的时间范围

Step 5 — 构建 prompt → 调用 AI
  - workEventPrompt（生成指令）
  - 抽取到的模板 JSON（骨架）
  - 当前时间 + 已有日程摘要 + 课程时间
  → AI 返回 JSON：{ events: [...] } 或 { events: [], reason: "..." }

Step 6 — 代码层校验
  - 时间合法性：start ≥ now + minLeadHours[scale] 且 start ≤ now + 7天（end 可超出）
  - 不生成今天及过去的日程
  - 工作时间带：起止在 07:00-22:00 JST 内（模板 note 中注明例外的除外，仅打 warning log）
  - Level 1：与所有有 time_slots 的 life_arc + 已预生成事件做时间重叠检测
  - Level 2：当天密度和 ≤ 1.0；多日事件按 duration_hours / duration_days 平均校验
  - 冲突策略：按 conflictPolicy[scale].allow 检查
  - 字段完整性：title / summary / time_start / time_end 不为空

Step 7 — 写入
  - 使用最新 life_arcs 再执行一次冲突校验，避免 AI 调用期间状态变化
  - 通过 → 在无 await 的临界段直接 `applyLifeArcOps` 并保存
  - 记录 lastGenerationAt 时间戳
  - 记录使用的 template index 到 `_lastGenerationTemplateIndices`（持久化）

该写入不依赖当前 active 角色，也不等待下一次对话；角色切换期间仍会正常生成并落盘。
  - saveRoleWorlds() 一次性持久化
```

### 6.3 生成 Prompt 结构

```
你是 {角色名} 的日程预生成器。根据给定的工作模板骨架，
为角色生成一个具体的、未来会发生的真实工作日程。

【最重要指令】
如果骨架在当前条件下没有合理的时间安排，你必须返回空 events 数组。
这比勉强生成一个会被系统拒绝的事件好。不合理的生成会被代码层丢弃，浪费一次调用。

【抽取到的模板】
{template JSON}

【当前时间】
{东京时间 ISO + 星期 + 时段}

【已有确定时间安排】
{有 time_slots 的 life_arcs + 已预生成事件，展开为具体日期和时间段列表}

【已有工作事件的进度状态】
{active work life_arcs 的 progress_note 摘要，用于避免与已有进度矛盾}

【以下日期有安排但时间未定，尽量避免全天工作】
{有 timeStart/timeEnd 但无 time_slots 的 life_arcs，仅列出日期和说明}

【约束】
- 事件在模板时长框架内（{duration_hours}h × {duration_days}天）
- 开始时间在 {earliest} ~ {windowEnd}（仅 start 受窗口上限约束，end 可超出）
- 不生成今天或过去的日程
- 事件起止时间应在 07:00-22:00 JST 内（深夜音番/直播等模板备注注明的例外除外）
- 多日事件每日实际工时尽量平均分配，单日不超过 {workHoursPerDay}h
- 当天所有事件的密度之和（duration_hours / {workHoursPerDay}）≤ 1.0
- 不要连续安排 heavy 事件；若已有日程中近期有 heavy，倾向于返回空或选择更轻量的事件
- light/medium 不得与【已有确定时间安排】中的任何条目时间冲突
- heavy 按冲突策略：{allow}；若与特殊日期冲突仍应拒绝
- 两个工作事件的时间范围不得重叠
- 事件之间至少间隔 {minGap} 分钟
- 对【日期未定安排】，尽量回避或留出弹性；无法避开时在 progress_note 中注明需要协调
- 日本演艺圈有季节性节奏（年末年始、黄金周、盂兰盆等），如当前日期临近这些时段请适当降低安排密度或返回空
- 在最早可行日期的基础上，随机向后偏移 0-4 天选择开始时间——不要总选窗口第一天，使日程节奏自然分散

【输出格式】
只输出 JSON：
{
  "events": [
    {
      "title": "具体工作名称（含节目名/期数/项目名，≤80字）",
      "summary": "工作内容概要（含主题、地点、合作者等，≤500字）",
      "time_start": "ISO 8601",
      "time_end": "ISO 8601",
      "progress_note": "当前准备状态或进度"
    }
  ],
  "reason": "生成理由简述"
}
没有合适日程时返回：
{ "events": [], "reason": "说明原因" }

【生成指引】
- title 要具体可辨认，非泛化的"工作"或"综艺录制"
- summary 包含够多具体信息，让 Actor 后续对话中可以自然引用
- progress_note 反映事件当前准备状态，不要与【已有工作事件的进度状态】中列出的进度矛盾
- 骨架框架下确实没有合适安排时，宁可返回空，不勉强生成
```

---

## 七、progress_note 更新机制修复

### 7.1 当前问题

`continuityUpdatePrompt`（每轮对话后调用的状态记账器，`bot.mjs` `finalizeTurnSuccess` 中）输出字段为：

```json
{
  "world_state_patch": {...},
  "open_thread_ops": [...],
  "follow_up_candidates": [...]
}
```

**缺少 `life_arc_updates` 字段**。每轮对话结束后，即使对话内容推进了某个 life_arc 的进展（如讨论了伊芙礼物的具体款式），progress_note 也不会更新。

以"伊芙的生日" life_arc（`data/wechat-worlds.json` 中 id `2c252dab-...`）为例：
- `2026-06-08` 创建，progressNote = 最初版本
- `2026-06-09 22:55` 手动更新一次（`updatedAt` 停留在此）
- 此后多轮对话讨论了"家纹发饰"等更具体的礼物方向
- progressNote 从未自动更新

**根因**：`applyLifeArcOps` 只被 `maybeCreateScheduleEntry`（日程最终确认流程）调用，`finalizeTurnSuccess` 中的 continuity update 没有写入 life_arc 的路径。

### 7.2 修复方案

**① continuityUpdatePrompt 增加输出字段**

```json
"life_arc_updates": [
  {
    "id": "life_arc UUID",
    "progress_note": "本轮对话后更新后的进展描述",
    "op": "update"
  }
]
```

**② finalizeTurnSuccess 中增加处理**

在 `bot.mjs` `finalizeTurnSuccess` 中，`applyWorldStatePatch` / `openThreadOps` 处理之后、`saveRoleWorlds()` 之前，增加：

```javascript
if (update.lifeArcUpdates?.length) {
  applyLifeArcOps(roleWorld, update.lifeArcUpdates.map(u => ({
    op: u.op || "update",
    id: u.id,
    progress_note: u.progress_note,
  })));
}
```

**③ 约束**

- continuity updater 只更新本轮对话中明确推进了进展的 life_arc
- 不要为每个 active life_arc 都生成空 update
- progress_note 增量更新：追加新进展，不覆盖已有不相关进展
- 如果某 life_arc 在本轮已解决/关闭（如礼物已买到），可 `op: "close"` 并注明原因

### 7.3 改动范围

| 文件 | 改动 |
|---|---|
| `app/lib/role-prompts.mjs` | `GENERIC_ROLE_PROMPTS.continuityUpdatePrompt`：增加 `life_arc_updates` 输出字段（全角色通用） |
| `app/bot.mjs` | `finalizeTurnSuccess`：新增对 `update.lifeArcUpdates` 的处理（全角色通用） |

`life_arc_updates` 作为所有角色的通用记账能力，放在 `GENERIC_ROLE_PROMPTS` 中。各角色在 `prompts.json` 中的 `continuityUpdatePrompt` 覆盖会自动继承该字段（通过 `mergeRolePrompts()` 的合并逻辑）。

---

## 八、配套 Prompt 调整

改动量小，预生成器上线后同步进行：

### 8.1 dailyShareSeedPrompt

增加："当 active life_arcs 中有进行中的 work event 时，可以优先从工作场景中取材。片场休息时的观察、综艺录制中的意外状况、试镜后的感受、移动中看到的风景。不强制，有其他自然素材时优先其他。"

### 8.2 sceneletInstructions

在"角色生活感"场景类目中补充：

```
- 工作间隙：化妆间候场、休息室喝咖啡、摄影棚转场路上、
  新干线移动中看台本、等待试镜结果、经纪人发来的邮件
```

### 8.3 scheduleExtractorPrompt

增加："当对话中角色明确提及了未来的工作安排（如'下周要进组'、'明天有录制'、'月底要去大阪'），应优先提取为 schedule_candidate。"

---

## 九、素材池演化策略

初始模板池（5.3 节，40 条）结合千圣剧情资料与日本演艺圈生态提炼。运行后根据实际效果持续增补：

- 观察模型填写的血肉是否真正多样化——如果总在某几个 subtype 上生成相似内容，说明模板需要更细粒度（如"美食外景"拆成"和食探店"和"洋食探店"）
- 你对千圣剧情的了解是主要扩展来源——想到新工作类型或情境，直接加到 JSON 中
- 密度调优路径：太闲 → 提高 `workHoursPerDay` 或降低 `generationIntervalMs`；太忙 → 反向调整

**模板池的角色可移植性**：其他角色启用时，只需提供自己的 `workEventTemplates` + `workEventPrompt` + 参数配置。如普通学生角色的模板池可能只有"考试"、"社团活动"、"打工"等，`allowConflict` 全部为 `false`，`generationIntervalMs` 更长。

---

## 十、实施计划

| 阶段 | 内容 | 依赖 | 改动文件 |
|---|---|---|---|
| **Phase 0**（新增） | `time_slots` 字段全链路支持 + 课表数据填充 | 无 | `normalize.mjs`, `world-state.mjs`（`applyLifeArcOps` + `lifeArcPromptItems`）, `wechat-worlds.json`（千圣课表手动加 time_slots） |
| Phase 1 | 修复 progress_note 更新（七）+ 原子写入边界 | Phase 0 | `role-prompts.mjs`（通用 continuityUpdatePrompt）, `bot.mjs`（life_arc_updates 处理）, `world-state.mjs` |
| Phase 2 | 日程预生成器模块（一～六） | Phase 1 | 新建 `work-event-generator.mjs`，改 `bot.mjs`（无条件注册 timer + 启动即检查）、`prompts.json`（加配置和模板池） |
| Phase 3 | 配套 prompt 调整（八） | Phase 2 | `prompts.json`（3 个字段微调） |
| Phase 4 | 运行观察 → 调整模板池和密度参数 | Phase 3 | `prompts.json`（模板池增补 + 参数调优） |

Phase 0 是阻塞性基础设施——没有它，Level 1 硬冲突检测没有数据源。Phase 1 加入了并发写入的队列化方案，与 time_slots 并行推进。Phase 2-3 在 Phase 0-1 完成后按设计实施。
