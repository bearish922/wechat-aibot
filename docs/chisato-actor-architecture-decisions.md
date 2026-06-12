# 白鹭千圣 Actor 架构决策记录

状态：第一次扩大实验已完成；新架构尚未进入生产实施阶段。
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

已决定完全删除独立 `scene_state`：它与 world state 的物理连续性职责重复，又容易重新承担心理压缩。若后续保留 Finalizer，则使用本轮开始状态与候选 patch 合并后的有效状态。

### 5.1 World State 不是永久事实

`world_state` 是唯一运行时状态源，但其中不同字段必须具有不同生命周期。不能因为字段被持久化到磁盘，就把它解释为数小时后仍然成立。

候选分层：

- `anchor_state`：相对稳定的当前锚点，例如位置、清醒状态、当前主活动。它持续有效，直到后续状态推进或新一轮 Actor 明确更新。
- `transient_context`：只在很短窗口内有效的现场，例如“Leo 正在催出门”“水壶刚响”“电车即将进站”。必须带 `observed_at` 和 `expires_at`，过期后不得注入 Actor 或 Finalizer。
- `body_state`：疲惫、困倦、冷、饿等短时状态，应带时间或 TTL；经过较长时间后由时间推进器重新判断，不能无限沿用。
- `current_plan`：近几小时已经决定执行的计划，不包括暂时考虑。应具有预计时间范围；过时后由推进器完成、更新或清除。
- `open_threads`：跨轮但未确定完成时间的轻量事项，使用独立生命周期和操作式管理。

例如“Leo 正在催出门”可以在本轮结束后的短时间内写入 `transient_context`，但若用户四小时后才回复，该字段已经过期。新的 Actor 输入只应看到经过时间推进后的有效状态，而不是原样读取旧快照。

由此，删除 `scene_state` 不意味着把所有场景细节永久塞进 world state；短时事实可以被存储用于近距离连续性，但必须自动失效。

当前实现核查：现有时间推进器只在生成 daily share 前检查 `stateStaleThresholdMs`，普通入站消息不会先推进过期 world state。因此新架构需要增加入站前的 state reconciliation：

1. 确定性清除已经超过 `expires_at` 的 `transient_context` 和 body state。
2. 完成或移除已经超过时间范围的 `current_plan`。
3. 若 anchor state 距离当前时间超过 stale threshold，再调用现有时间推进模块，根据经过时间和 life arcs 更新位置、活动、清醒状态和短期计划。
4. 只有协调后的有效状态才能进入 Actor turn body。

这一流程属于 Actor 前置状态准备，不应让 Actor 在生成 inner/reply 时顺便承担。

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

### 7.1 已批准决策

用户于 2026-06-13 批准：

- RAG/事实材料前移到 Actor 之前。Actor 与双调用 Finalizer 应看到同一份本轮相关事实包。
- 删除独立 `scene_state`。后续只讨论 world state、patch、生命周期和入站前状态协调。
- 第一次扩大实验不包含 world state、patch、open threads、follow-up、schedule 或其他 postprocessor 输出。

## 8. 扩大实验：已确认修正

- 不再使用 2026-06-12 15:42 梦境边界和 22:08 武士饰品两个旧案例作为正式样本。
- 需要选择两个新的高诊断性案例，分别覆盖“表达边界”和“心理因果传递”，避免对旧案例过拟合。
- 当前真实历史记录应作为 baseline reference，不需要为了得到基线而重新调用现行架构。
- 若需要测量现行架构的随机性，可另设“current rerun”探索组，但不能和历史真实输出混称为基线。
- 调用次数应按候选架构真实计算：双调用候选每个样本两次模型调用；单调用候选一次。历史基线不产生新调用。
- 主评价对象是 inner 和微信回复；状态、threads、follow-up 等作为次级诊断指标。
- 模型不参与自评，最终样本匿名、打乱后由人工评价。
- 第一阶段只测试核心角色生成，不运行新的 postprocessor。双调用组只生成 Actor 的 inner/seed 和 Finalizer 回复；单调用组只生成 inner/reply。
- 第一阶段冻结全部核心输出后，再使用同一批冻结结果测试 postprocessor，避免辅助任务反向污染 Actor，也避免重复生成造成比较条件变化。

### 8.1 两个新的高诊断候选案例

正式案例一：2026-06-12 12:13，用户说要直接去问小彩此前的暧昧问题，并强调不把截图发给千圣。

- 原 inner 准确形成了“真正难受的是不知道小彩会怎么回答”的心理核心，并出现“说随你，但其实不随”的表达边界。
- 原回复隐藏了在意，但仍残留引用战报、武器、口说无凭等攻防语汇。
- 用于评价：细微在意、控制感与不确定性是否能自然进入回复，而不泄漏全部内心，也不写成语言竞技。

正式案例二：2026-06-12 23:24（东京时间），用户在拿到鞋码后说国际物流方便，让千圣等着。

- 原 inner 已经承认尺码给出去就等于答应，并自然产生了对礼物款式的期待和“即使不合适也会穿”的柔软念头。
- 原回复却以“输了”开头，把接受礼物重新编码成胜负，并追加不必要的管理式收束。
- 用于评价：inner 的柔软接受能否以千圣式克制自然导出，而不是被固定的输赢/攻防模板覆盖。

用户已于 2026-06-13 确认这两个案例通过，纳入正式扩大实验。实验仍应补充普通日常、说教、轻量闲聊、强情绪、物理连续性和计划承诺等类型。

### 8.1.1 第一次扩大实验样本集

第一次扩大实验使用 8 条真实历史消息，每条独立生成两次：

1. 2026-06-12 14:25（东京时间）：用户直接说“想看你着急”。测试直接情绪要求下的自然承认。
2. 2026-06-12 15:10（东京时间）：用户说千圣“高兴坏了”、彩“死心塌地”，并建议奖励布丁。测试被点破欣喜后的克制与日常行动。
3. 2026-06-12 18:17（东京时间）：用户指出“不会想 18+”与“很单纯”并不矛盾，并继续暧昧逗弄。测试承认判断错误、边界和避免输赢模板。
4. 2026-06-12 21:13（东京时间）：用户说要直接问彩并不发截图。测试不确定性、在意与表达边界。
5. 2026-06-12 23:24（东京时间）：用户拿到鞋码后让千圣等着收礼物。测试柔软接受能否自然进入回复。
6. 2026-06-12 23:27（东京时间）：用户问周末是否也完全不熬夜。测试普通日常关心、想继续聊天与说教分寸。
7. 2026-06-13 01:40（东京时间）：用户深夜回复“狗饼好可爱”。测试低能量、睡眠状态和短回复自然度。
8. 2026-06-13 01:56（东京时间）：用户发现千圣已经睡了并道晚安。测试不回复、极简状态表达和角色真实性。

历史真实 inner/reply 作为 `H` 参照，不重新调用当前生产架构。候选组：

- `D`：Actor 输出 `inner_scenelet + visible_reply_seed`，Finalizer 根据 seed 输出最终回复。
- `S`：同一 Actor Prompt 输出 `inner_scenelet + visible_reply`，直接作为最终回复。

每个候选组、每个案例独立运行两次，不共享 session，不运行工具；历史轮次已经出现的 RAG 结果在 Actor 前置输入，双调用 Finalizer读取同一事实包。模型不自评。

### 8.1.2 第一次扩大实验结果

实验已完成，完整报告见 `docs/expanded-actor-experiment-2026-06-13.md`。

主要结果：

- 单调用 16 份、双调用 16 份正式候选全部补齐；初始完整字段契约可用率为 26/32（81.25%），其余通过只补跑缺失槽位和纯格式重试补齐。
- 两组都没有再观察到 `scene_state` 有损传递导致的 inner/reply 因果断裂，支持由同一个 Actor 完成 inner 与可见表达决策。
- 双调用 Finalizer 的 16 份输出与 Actor seed 逐字完全相同，没有提供可观察的质量收益，却增加了成本。
- 当前主要质量瓶颈位于 Actor：仍频繁把暧昧逗弄写成输赢、回合、武器、收网或对用户话术的逐段复盘。
- 候选可见回复全部去除了括号舞台动作；“已经睡着”案例四次都正确选择空回复。
- 模型仍会为了生活质感补写未确认的照片、店铺、日程、宠物动作和他人状态。移除辅助字段后该问题仍存在，不能完全归因于 world state/follow-up 多任务干扰。
- “狗饼”案例缺少明确的有效 world state 前态，不能用于评价物理连续性；后续实验必须向 Actor 注入经过生命周期协调的有效前态。

当前实验结论倾向以“前置 RAG/事实材料 + 有效 world state + 单个 Actor 生成 inner/reply + 回复冻结后 postprocessor”为下一轮调优骨架。该倾向不是最终生产架构决定；若保留 Finalizer，必须先证明它能在不改变语义边界的前提下提供可观察收益。

### 8.2 Postprocessor 后续实验

第一阶段不运行 postprocessor。核心架构选型完成后，再设计并测试以下候选：

1. 单一 postprocessor：一次读取已冻结的 user message、inner、最终回复、开始状态和有效上下文，同时输出：
   - `world_state_patch`
   - `open_thread_ops`
   - `follow_up_candidates`
   - 可选的 schedule candidates
2. 状态 postprocessor 与主动联系模块分离：前者只更新 world state/open threads，后者只判断 follow-up。
3. 轻量规则先过滤，再由一个模型处理剩余字段。

优先测试合并版，因为这些输出都属于“回复已经确定后的本轮后处理”，共享大量输入。是否最终拆分取决于：

- follow-up 任务是否会诱导 postprocessor 过度创造未来剧情。
- 合并后 world state/open threads 的准确性是否下降。
- schedule candidates 是否因任务稀疏而被硬填。
- 成本与延迟是否显著改善。

无论采用哪种形式，postprocessor 只能读取并解释冻结后的角色输出，不能修改 inner 或最终回复；所有更新只在消息成功发送后提交。

当前优先候选是将 `world_state_patch`、`open_thread_ops` 与 `follow_up_candidates` 合并到一次 postprocessor 调用：

- 三者共享用户消息、inner、最终回复、开始状态、时间和 life arcs。
- 输出顺序固定为 state patch、thread ops、follow-up；先记录已经成立的结果，最后才考虑未来联系。
- follow-up 默认为空，不能为了字段完整而生成。
- follow-up 只产生候选，不直接修改 world state，也不把候选中的未来事件写成已经决定的计划。
- 三类输出分别规范化和验证；某一部分无效时不应丢弃其他有效部分。

Schedule candidate 暂不建议无条件并入同一调用。它稀疏、规则复杂、对长期状态影响更大，优先保留为显式时间信号触发的独立模块。后续可以测试受门控的合并形式：只有冻结输入中检测到未来时间锚点时，才要求同一个 postprocessor 额外输出 schedule candidates。

## 9. 尚未解决的问题

- `world_state_patch` 应由 Actor 直接生成，还是在 reply 确定后由便宜的独立 extractor 生成，以减少多任务干扰。
- `transient_context`、`body_state` 和 `current_plan` 的准确 TTL、过期清理及时间推进规则。
- 双调用 Finalizer 的最小输入和允许改写范围。
- Open thread 的精确 schema、生命周期和提交规则。
- 下一轮扩大实验的新案例选择、样本规模、重复次数和多轮脚本。
- RAG/搜索无法在 Actor 前预判需求时如何补救。
- Postprocessor 最终采用合并还是拆分，以及是否包含 schedule candidate 提取。
