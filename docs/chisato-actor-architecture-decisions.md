# 白鹭千圣 Actor 架构决策记录

状态：持续讨论中，尚未进入扩大实验或新架构实施阶段。
创建日期：2026-06-13

本文记录已经确认的目标、证据、约束和待决问题。讨论继续期间应持续更新；不得把“候选方案”误写成已确定实现。

## 1. 核心质量目标

第一优先级：

- `inner_scenelet` 像白鹭千圣真实、自然、具体的内心声音，而不是文学旁白、剧本或对用户消息的逐句分析。
- 微信回复由同一份心理判断自然导出，保留角色的表达边界、心理因果和当下反应。

第二优先级：

- 物理位置、时间、动作和生活状态保持连续。
- 暂时念头、未决事项、后续联系和日程不会互相污染。
- 辅助字段不得为了“填完整”而反向诱导 inner 或微信回复创造剧情。

## 2. 已确认的问题

- 旧架构把完整 `inner_scenelet` 注入主回复，可能泄漏 inner 明确决定不说出口的内容。
- 当前双输出架构把第三人称 `scene_state` 注入主回复，但有损压缩可能丢失或翻转心理因果，使 Hidden World 和主回复平行生成。
- 将 inner 与最终回复放在同一次 Actor 认知过程中，轻量实验中显著改善了表达边界和心理因果；这不等于所有工程任务都应合并到一个大 Prompt。
- 多任务干扰仍然存在。`world_state_patch` 和 follow-up 可能反向诱导模型创造行动、计划和私人事实。
- 千圣的暧昧反应不应默认写成输赢、攻防、供词或逐句拆解。目标是自然的人类反应，包括羞赧、紧张、被看见的欣喜、回避、短促反击、摆烂、偶尔失控或真情流露。
- 千圣在日常中仍是高掌控感、高理性、温柔而生动的角色，会关心、吐槽、开玩笑、说教、分享日程，并拥有与用户无关的持续生活。
- `inner_scenelet` 不应强制描写场景。环境只在自然进入意识、触发联想、打断思考或提供行动出口时出现；不使用括号动作和固定镜头调度。

## 3. Session 生命周期决策

- session ID 只能由首次创建、后端首次绑定真实 thread ID，或明确 reset 流程改变。
- retry 不得创建新 session，不得丢弃隐形上下文，不得伪装成 reset。
- Hidden World 无效输出的 retry 必须 resume 原 session。
- 主回复后端报告 session 不存在时，本轮失败并等待明确 reset，不得静默新建 session 重跑。
- 失败轮不得提交世界状态、对话历史、follow-up 或日程变化。

上述 runtime 约束已于 2026-06-13 实施并加入回归测试。

## 4. 当前候选架构

尚未最终决定采用单调用或双调用。

### 4.1 双调用候选

调用 A 是 Actor，在同一次认知过程中依次生成：

1. `inner_scenelet`
2. 接近成品的 `visible_reply_seed`
3. 物理/时间状态输出
4. 轻量线程操作和其他辅助候选

调用 B 是受约束的 Finalizer：只改善微信体裁、节奏、长度和事实材料融合，不得改变 seed 的承认程度、回避边界、关系立场或核心因果。Finalizer 不读取完整 inner。

### 4.2 单调用候选

同一个 Actor 依次生成：

1. `inner_scenelet`
2. 最终 `visible_reply`
3. 状态和其他辅助输出

工程型任务仍可在调用前后独立完成；“单调用”只表示本轮角色心理与最终回复由同一个 Actor 调用完成。

## 5. Scene State 与 World State：待决

此前提出额外 `scene_frame`，用于给 Finalizer 提供本轮物理与时间约束。但它与 `world_state_patch` 存在明显职能重叠。

当前需要继续讨论的更简洁方向：

- 使用“本轮开始前的完整 `world_state`”约束 Actor。
- Actor 在 seed/reply 之后输出“本轮结束后的 `world_state_patch`”。
- Finalizer 若需要物理约束，可以读取开始状态和 patch 合并后的候选结束状态，而不再增加独立 `scene_state`。
- 必须明确 patch 是“本轮回复发生后的真实状态”，不能包含仅仅想到、考虑或尚未承诺的计划。
- 若一个临时、只供本轮表达使用的感官细节不值得持久化，应由 Actor 自然保留在 inner 或 seed 中，而不是强迫写入 world state。

是否完全删除 `scene_state` 尚未最终确认。

## 6. Open Threads：待优化

当前 `openThreads` 是最多八条无 ID 字符串，存在以下问题：

- 模型整表重写，不是真正的增删操作。
- 空数组无法明确清空旧线程。
- 缺少来源、可见性、承诺程度和过期时间。
- 无法区分暂时念头、未决任务、情绪余波和对话钩子。
- 容易把一轮玩笑或一次性情绪固化成长期事实。

候选方向是改为 `open_thread_ops`，支持 `add/update/close`，并至少表达：

- `kind`: `tentative_plan | unresolved_task | emotional_residue | conversation_hook`
- `visibility`: `private | shared`
- `commitment`: `thought | considering | intended | committed`
- `summary`、`expires_at`、`evidence`

暂时念头和非确定计划应进入 thread，而不是 `current_plan`。只有近几小时已经决定执行的事项才进入 `current_plan`。并非所有模糊情绪都持久化；一闪而过的感受只留在 inner。

## 7. Prompt 分层原则

新架构不能只靠继续膨胀 `sceneletInstructions` 实现。

- Profile：稳定身份、固定事实、人格内核、长期关系和跨场景反应空间；不放 JSON 契约、当前状态和机械触发规则。
- Actor system prompt：本次认知任务、输出顺序、inner/seed/reply 的关系、辅助字段不得反向干扰等架构规则。
- Actor turn body：当前消息、最近可见历史、近期心理连续性、当前 world state、life arcs、相关记忆、时间天气、RAG/事实包等每轮动态材料。
- Finalizer system prompt（仅双调用）：把 seed 当语义合同，禁止重新做角色心理决策。
- Finalizer turn body（仅双调用）：当前消息、少量可见历史、seed、必要状态和事实材料；不提供完整 inner。
- Bridge：双调用时应从“根据 scene state 重新生成回复”改为“忠实实现 seed”。单调用不需要 bridge。
- Scene memory：reset 前总结可见历史、近期 inner、世界状态和未闭合心理轨迹，作为显式连续性保障。

## 8. 扩大实验：已确认修正

- 不再使用 2026-06-12 15:42 梦境边界和 22:08 武士饰品两个旧案例作为正式样本。
- 需要选择两个新的高诊断性案例，分别覆盖“表达边界”和“心理因果传递”，避免对旧案例过拟合。
- 当前真实历史记录应作为 baseline reference，不需要为了得到基线而重新调用现行架构。
- 若需要测量现行架构的随机性，可另设“current rerun”探索组，但不能和历史真实输出混称为基线。
- 调用次数应按候选架构真实计算：双调用候选每个样本两次模型调用；单调用候选一次。历史基线不产生新调用。
- 主评价对象是 inner 和微信回复；状态、threads、follow-up 等作为次级诊断指标。
- 模型不参与自评，最终样本匿名、打乱后由人工评价。

## 9. 尚未解决的问题

- 是否完全删除 `scene_state`，由 world state 前态与 patch 承担全部物理连续性。
- `world_state_patch` 应由 Actor 直接生成，还是在 reply 确定后由便宜的独立 extractor 生成，以减少多任务干扰。
- 双调用 Finalizer 的最小输入和允许改写范围。
- Open thread 的精确 schema、生命周期和提交规则。
- 扩大实验的新案例选择、样本规模、重复次数和多轮脚本。
- RAG/搜索是否必须前移到 Actor 之前，以及无法预判检索需求时如何补救。
