# WeChat AI Bot

> v2.5.1 — Windows 本机运行的微信 AI 助手

WeChat AI Bot 监听微信消息，将文字、图片、语音、文件、视频交给 Claude Code 或 Codex 回复。它支持多线程会话、角色扮演、本地知识库、长期记忆、主动回复、可编辑 prompt 管线，以及本地 GUI。

需要 Node.js 22+，面向 Windows 本机运行。

## 功能

- **双 AI 后端** — `/cc` `/codex` 随时切换，各自保留独立会话。
- **多线程** — 创建、切换、重命名、关闭线程，状态持久化，重启可恢复。
- **角色扮演** — 内置长崎素世、千早爱音、丸山彩、白鹭千圣四个 BangDream 角色，可自定义。
- **隐藏 scenelet** — 角色回复前先生成隐藏的 `inner_scenelet` 和轻量 `scene_state`，让回复带有当前生活现场和连续性。
- **可搜索 scenelet** — scenelet 默认运行在可用 `WebSearch/WebFetch` 的 Claude Code 环境中，遇到书、歌、作者、公开人物近况、截图 OCR 等可核验事实时可以先查再写。
- **主动回复** — 角色可以生成一次性 proactive intent，包括 follow-up 和 daily share；到点后会二次判断是否发送。
- **长期记忆** — 每个角色独立维护对用户的长期记忆，自动写入稳定信息，也支持 `/memory` 查看。
- **知识库 RAG** — 本地 Markdown 知识库构建向量索引，角色对话时按触发条件检索。
- **多媒体** — 图片/语音/文件/视频自动下载；图片和视频首帧可接视觉模型；微信 `.silk` 语音可通过 WhisperX 转写。
- **聊天历史** — 持久化存储，GUI 内按对话浏览、搜索、展开 scenelet。
- **Prompts GUI** — 运行时 prompt、RAG 触发词、scenelet/proactive/voice/vision 相关说明可在 GUI 中查看和编辑，默认 prompt 配置版本化保存在 `data/prompts.json`。
- **本地 GUI** — `http://127.0.0.1:18720`，包含 Status / Sessions / Profiles / History / Config / Memory / Prompts / Proactive 等页面。

## 快速开始

```bat
scripts\setup.bat
copy app\config.example.json data\config.json
scripts\rebuild-rag.bat
launch.bat
```

启动后按终端提示扫码登录微信，浏览器会自动打开 GUI。

## 依赖

| 依赖 | 必需 | 用途 |
|------|------|------|
| Node.js 22+ | 是 | 运行 bot 和本地 GUI |
| Python 3 + pip | 是 | RAG、文件文本提取 |
| Claude Code 或 Codex | 至少一个 | AI 回复后端 |
| ffmpeg | 否 | 视频首帧提取 |
| OpenAI-compatible 视觉 API | 否 | 图片/视频描述 |
| WhisperX | 否 | 更准确的语音转文字，尤其是日语语音 |

## 配置

`data/config.json` 从 `app/config.example.json` 复制。`data/config.json` 是本地私有配置，不进入版本控制；仓库里的示例配置只保留通用占位。

常用字段：

```json
{
  "paths": {
    "claude": "留空则自动从 PATH 查找",
    "codex": "留空则自动从 PATH 查找",
    "workDir": "Claude/Codex 工作目录，默认用户目录"
  },
  "proxy": {
    "https": "共享代理，例如 http://127.0.0.1:7892",
    "claudeHttps": "单独给 Claude Code 的代理",
    "codexHttps": "单独给 Codex 的代理",
    "ragHttps": "RAG 脚本代理"
  },
  "models": {
    "claudeMain": "主回复模型",
    "claudeFast": "快速模型",
    "claudeFallback": "回退模型",
    "scenelet": "scenelet / hidden call 模型"
  },
  "scene": {
    "sceneletBare": false
  },
  "vision": {
    "mode": "auto / external / native / off",
    "apiKey": "外部视觉 API Key"
  },
  "voice": {
    "enabled": true,
    "whisperxPython": "WhisperX 虚拟环境里的 python.exe",
    "language": "auto 或 ja/zh/en 等语言代码"
  },
  "rag": {
    "knowledgeDir": "你的 Markdown 知识库目录",
    "storeDir": "data/rag_vector_store"
  }
}
```

环境变量可覆盖配置：`WECHAT_CLAUDE_PATH`、`WECHAT_CODEX_PATH`、`WECHAT_AI_WORK_DIR`、`WECHAT_HTTPS_PROXY`、`WECHAT_CLAUDE_HTTPS_PROXY`、`WECHAT_CODEX_HTTPS_PROXY`、`WECHAT_RAG_HTTPS_PROXY`、`WECHAT_VISION_MODE`、`WECHAT_VISION_BASE_URL`、`WECHAT_VISION_API_KEY`、`WECHAT_VISION_MODEL`、`WECHAT_VOICE_WHISPERX_PYTHON`、`WECHAT_VOICE_LANGUAGE`、`WECHAT_LOG_RETENTION_DAYS`。

### AI 后端登录

安装 Claude Code 或 Codex 后，先在普通终端确认能正常进入：

```bat
claude
```

或：

```bat
codex
```

通常不需要手动填写路径；如果自动查找失败，再在 `data/config.json` 中配置 `paths.claude` 或 `paths.codex`。

### 知识库

默认示例知识库在 `data/knowledge/`。如果你有自己的 Markdown 知识库，把 `rag.knowledgeDir` 改成对应目录，例如 Obsidian vault 中的某个文件夹。

修改知识库后运行：

```bat
scripts\rebuild-rag.bat
```

向量索引默认写入 `data/rag_vector_store/`，这是本地生成物，不进入版本控制。

### Prompts

GUI Prompts 页编辑的内容保存在 `data/prompts.json`。从 v2.5.0 开始，默认 prompts 会随仓库版本化，方便作为 prompt 管线示例分享；真实运行时仍可在 GUI 中继续编辑。

### 语音转文字

微信语音会先保存为 `.silk`，bot 使用 `silk-wasm` 解码，再调用 WhisperX：

```json
{
  "voice": {
    "enabled": true,
    "whisperxPython": "path\\to\\whisper_env\\Scripts\\python.exe",
    "language": "auto"
  }
}
```

如果未安装 WhisperX，启动时只会显示 warning，程序仍会使用微信自带转写作为 fallback。若完全不想启用 WhisperX：

```json
{
  "voice": {
    "enabled": false
  }
}
```

## 微信命令

| 命令 | 说明 |
|------|------|
| `/cc` `/codex` | 切换 AI 后端 |
| `/new [名称]` | 创建新线程；名称匹配角色名时自动绑定角色 |
| `/switch [序号\|名称]` | 切换活跃线程 |
| `/rename [序号\|名称] <新名称>` | 重命名线程 |
| `/close [序号\|名称]` | 关闭线程 |
| `/sessions` | 查看所有线程 |
| `/cancel` | 取消当前任务 |
| `/status` | 当前状态：AI、模型、线程、角色 |
| `/profile` | 查看所有角色 |
| `/profile <名称>` | 绑定角色到当前线程 |
| `/profile off` | 解除角色绑定 |
| `/memory` | 当前角色记忆摘要 |
| `/memory all` | 当前角色记忆全文 |
| `/memory <角色名>` | 查看指定角色的记忆 |
| `/memory 性格\|偏好\|事实` | 按分类查看 |
| `/help` | 查看帮助 |

## 角色

角色模板保存在 `wechat-profiles.json`，可通过 GUI 或文本编辑器修改。线程绑定角色后，会持续使用对应 profile、长期记忆、可见上下文、scenelet 和 RAG 规则。

每轮回复都会注入当前本地时间和时段，模型会据此调整语境。

## 长期记忆

每个角色独立维护 `wechat-memory.json`。记忆分 `trait` / `preference` / `fact` 三类，回合结束后由 memory writer 判断是否写入。当前消息优先于旧记忆。

`wechat-memory.json` 是本地个人数据，不进入版本控制；新用户从 `wechat-memory.example.json` 开始。

## 附件

- **图片** — 下载后按 `vision.mode` 调用外部视觉模型生成描述。
- **语音** — 保存 `.silk`，优先使用 WhisperX 转写；失败时保留微信自带转写。
- **文件** — 保存后提取 PDF / DOCX / PPTX / XLSX 文本预览。
- **视频** — 保存后可用 ffmpeg 截取首帧描述。

发送附件后有 30 秒合并窗口，期间追加的文字会作为附件补充说明一起进入同一轮。

## 本地数据

| 路径 | 内容 | 是否版本化 |
|------|------|------|
| `data/config.json` | 本机配置、路径、API key | 否 |
| `data/prompts.json` | 默认 prompt 管线配置 | 是 |
| `data/wechat-token.json` | 微信登录态 | 否 |
| `data/wechat-sessions.json` | 会话状态 | 否 |
| `wechat-profiles.json` | 角色模板 | 是 |
| `wechat-memory.json` | 长期记忆 | 否 |
| `data/chat-history.json` | 聊天历史 | 否 |
| `data/logs/` | AI 调用日志 | 否 |
| `data/inbound_media/` | 收到的附件 | 否 |
| `data/rag_vector_store*/` | 知识库向量索引 | 否 |

升级时通常保留 `data/config.json`、`data/wechat-token.json`、`data/wechat-sessions.json`、`wechat-profiles.json`、`wechat-memory.json` 和自定义知识库即可。

## GUI

`http://127.0.0.1:18720`，仅监听本机。

| 页面 | 功能 |
|------|------|
| Status | 在线状态、当前 AI、模型、启动检查 |
| Sessions | 线程列表、CLI 恢复指令 |
| Profiles | 编辑/新增/删除角色模板 |
| History | 聊天历史、搜索、scenelet 展开 |
| Config | 编辑 `data/config.json` |
| Memory | 查看长期记忆 |
| Prompts | 查看和编辑 prompt 管线、RAG 关键词与阈值 |
| Proactive | 查看主动回复候选、发送/取消状态和 inner scenelet |

## 许可

MIT
