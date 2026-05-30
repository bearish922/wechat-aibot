# WeChat AI Bot

> v2.2.0 — Windows 本机运行的微信 AI 助手

WeChat AI Bot 监听微信消息，将文字、图片、语音、文件、视频整理后交给 Claude Code 或 Codex 回复。它支持多线程会话、角色扮演、本地知识库检索、附件理解、日志留存和本地 Web 管理界面。

本项目面向 Windows 本机运行。当前代码使用 `import.meta.dirname`，推荐 Node.js 22+。

## 功能

- **双 AI 后端**：Claude Code 和 Codex 可在微信命令中切换，并各自保留独立会话。
- **Chat / Tool 会话分流**：工具线程继续使用 Claude Code/Codex 执行项目任务；轻量聊天线程使用 OpenAI-compatible Chat Completions API，避免长闲聊反复恢复工具上下文。
- **多线程会话**：支持创建、切换、重命名、关闭线程，线程类型和状态会写入本地文件，重启后可恢复。
- **角色扮演**：从 `wechat-profiles.json` 加载角色模板，内置长崎素世、千早爱音、丸山彩、白鹭千圣等 BangDream 角色设定。
- **回复风格控制**：通过长度预算、场景判断和近期颜文字记忆，让闲聊更短、更像微信私聊，任务回复仍可结构化。
- **多媒体理解**：可保存并处理图片、语音、文件、视频；图片和视频首帧可接入 OpenAI-compatible 视觉模型生成中文描述。
- **长期记忆**：从 `wechat-memory.json` 读取结构化用户记忆，非默认角色线程会自动注入相关上下文。
- **本地知识库**：`data/knowledge/` 目录中的 Markdown 会被构建为本地 Qdrant 向量索引，角色线程查询时可自动锚定角色名。
- **本地 GUI**：启动后打开 `http://127.0.0.1:18720`，提供 Status、Sessions、Profiles、Config 四个页面。
- **日志与媒体清理**：AI 调用生成 JSONL 和可读日志；日志可自动清理，媒体文件可用微信命令或脚本手动清理。

## 依赖

| 依赖 | 用途 | 必需 |
|---|---|---|
| Node.js 22+ | 主程序和本地 GUI | 是 |
| Python 3 + pip | 文件内容提取、RAG 向量检索 | 是 |
| Claude Code | Claude Code 后端 | 至少配置一个 AI 后端 |
| Codex | Codex 后端 | 至少配置一个 AI 后端 |
| OpenAI-compatible Chat API Key | 轻量聊天线程 | 使用 chat 线程时 |
| ffmpeg | 视频首帧提取 | 否 |
| OpenAI-compatible 视觉 API Key | 图片/视频首帧描述 | 否 |

## 快速开始

在项目目录中运行：

```bat
scripts\setup.bat
copy app\config.example.json data\config.json
scripts\rebuild-rag.bat
launch.bat
```

大多数情况下不需要先编辑 `data/config.json`。启动后按终端提示扫码登录微信。登录完成后，浏览器会自动打开 `http://127.0.0.1:18720`。

### 配置重点

`data/config.json` 从 `app/config.example.json` 复制得到。能自动发现或使用默认值的字段可以保留原样：

```json
{
  "paths": {
    "npmGlobal": "可选；默认自动查找 npm 全局目录",
    "claude": "可选；默认从 PATH 自动查找 claude",
    "codex": "可选；默认从 PATH 自动查找 codex",
    "ragScript": "可选；默认使用 app/rag.py",
    "workDir": "可选；默认使用当前 Windows 用户目录"
  },
  "proxy": {
    "https": "",
    "claudeHttps": "",
    "codexHttps": "",
    "ragHttps": ""
  },
  "models": {
    "claudeFast": "闲聊快速模型",
    "claudeFallback": "Claude fallback 模型"
  },
  "timeouts": {
    "aiMs": 600000
  },
  "vision": {
    "mode": "auto",
    "baseUrl": "https://api.siliconflow.cn/v1",
    "apiKey": "",
    "model": "Qwen/Qwen3-VL-32B-Instruct",
    "detail": "high",
    "timeoutMs": 180000
  },
  "chat": {
    "baseUrl": "",
    "apiKey": "",
    "model": "",
    "temperature": 0.8,
    "maxTokens": 800,
    "timeoutMs": 120000,
    "compactKeepTurns": 6
  },
  "rag": {
    "enabled": true,
    "knowledgeDir": "data/knowledge",
    "storeDir": "data/rag_vector_store",
    "modelCacheDir": "data/.fastembed_cache",
    "collectionName": "bangdream_knowledge",
    "embedModel": "BAAI/bge-small-zh-v1.5",
    "topK": 3,
    "minScore": 0.48,
    "scoreMargin": 0.16,
    "chunkMaxChars": 1600,
    "resultMaxChars": 1200,
    "batchSize": 32
  },
  "logs": {
    "retentionDays": 30
  }
}
```

这些环境变量可覆盖配置：`WECHAT_CLAUDE_PATH`、`WECHAT_CODEX_PATH`、`WECHAT_AI_WORK_DIR`、`WECHAT_HTTPS_PROXY`、`WECHAT_CLAUDE_HTTPS_PROXY`、`WECHAT_CODEX_HTTPS_PROXY`、`WECHAT_RAG_HTTPS_PROXY`、`WECHAT_VISION_MODE`、`WECHAT_VISION_BASE_URL`、`WECHAT_VISION_API_KEY`、`WECHAT_VISION_MODEL`、`WECHAT_CHAT_BASE_URL`、`WECHAT_CHAT_API_KEY`、`WECHAT_CHAT_MODEL`、`WECHAT_CHAT_TEMPERATURE`、`WECHAT_LOG_RETENTION_DAYS`。

`paths.claude` 和 `paths.codex` 可以留空或保留示例占位；程序会先从环境变量读取，再从 PATH 自动查找 `claude` / `codex`。找不到时才使用 npm 全局安装目录下的常见路径。

### 哪些需要填写

| 配置 | 默认行为 | 什么时候需要填写 |
|---|---|---|
| `paths.claude` / `paths.codex` | 自动从 PATH 和 npm 全局目录查找 | 只有自动查找失败，或你想指定某个固定安装路径 |
| `proxy.https` | 空值，不使用代理 | 作为 Claude/Codex/RAG 未单独配置时的共享代理 |
| `proxy.claudeHttps` / `proxy.codexHttps` / `proxy.ragHttps` | 空值，沿用 `proxy.https` 或直连 | 需要让不同后端使用不同代理策略时 |
| `vision.apiKey` | 空值，不调用外部视觉 API | AI 后端本身不支持视觉，但你希望它能看图/看视频首帧时 |
| `vision.baseUrl` / `vision.model` | 默认 SiliconFlow + Qwen vision 模型 | 使用其他 OpenAI-compatible 视觉服务时 |
| `chat.baseUrl` / `chat.apiKey` / `chat.model` | 空值，chat 线程会提示未配置 | 想用轻量聊天线程承接长时间角色闲聊时 |
| `chat.compactKeepTurns` | 6 | `/compact` 后保留最近多少轮完整对话 |
| `rag.knowledgeDir` | 使用项目内 `data/knowledge/` | 想换成自己的 Markdown 知识库目录时 |
| `paths.workDir` | 当前 Windows 用户目录 | 希望 Claude/Codex 在指定项目目录或工作区运行时 |

### AI 后端登录

至少安装并登录 Claude Code 或 Codex 中的一个。安装完成后，先在普通终端里运行一次：

```bat
claude
```

或：

```bat
codex
```

确认能正常进入对应 CLI 后，再启动 bot。路径通常不需要填写。

### 图片识别模式

`vision.mode` 支持：

- `auto`：默认值；配置了外部视觉 API 时先生成图片/视频首帧描述，否则只保留本地媒体路径和基础信息。
- `external`：强制使用 OpenAI-compatible 视觉 API，适合 Claude Code 后端本身不支持视觉、但另配视觉模型的场景。
- `native`：不调用外部视觉 API，只保留本地媒体路径和基础信息。
- `off`：不调用外部视觉 API，也不要求后端读取图片，只保留媒体路径和基础信息。

如果你希望角色能稳定理解图片/视频首帧，建议保留 `auto` 并填写 `vision.apiKey`，或把 `vision.mode` 设为 `external`。程序不会再提示 Claude Code/Codex 直接读取本地图片文件，以免把 base64 图片内容带入工具会话历史。

### Chat / Tool 线程

线程有两种类型：

- `tool`：继续调用 Claude Code 或 Codex，适合查项目、改文件、运行命令、推送代码等工作。
- `chat`：调用 `chat.*` 中配置的 OpenAI-compatible Chat Completions API，适合长期角色闲聊。chat 线程默认保留完整对话历史，不自动截断。

默认迁移规则：Claude Code 下名为 `cst`、`anon`、`soyo`、`aya` 的线程会作为 chat 线程，其它线程保持 tool。你也可以手动创建或切换：

```text
/new chat cst
/new tool research
/mode chat
/mode tool
```

如果 chat 线程历史过长，可以手动发送 `/compact`。它会调用同一个 chat API 将早期历史压缩成摘要，并保留最近 `chat.compactKeepTurns` 轮完整对话。

### 代理、自定义知识库和工作目录

没有代理就让对应代理字段保持空字符串。需要代理时填写形如 `http://127.0.0.1:7892` 的地址。`proxy.https` 是共享 fallback；如果要让 Claude 直连、Codex 走代理，可以设置：

```json
"proxy": {
  "https": "",
  "claudeHttps": "",
  "codexHttps": "http://127.0.0.1:7892",
  "ragHttps": ""
}
```

默认知识库是项目内 `data/knowledge/`。如果要改用自己的 Markdown 知识库，把 `rag.knowledgeDir` 改成绝对路径或相对项目目录的路径，然后重新运行：

```bat
scripts\rebuild-rag.bat
```

`paths.workDir` 控制 Claude/Codex 的运行目录。默认是当前 Windows 用户目录；如果你希望工具读写某个固定项目，把它改成对应目录即可。

## 微信命令

| 命令 | 说明 |
|---|---|
| `/cc` | 切换到 Claude Code |
| `/codex` | 切换到 Codex |
| `/new [名称]` | 创建新线程 |
| `/new chat [名称]` | 创建轻量聊天线程 |
| `/new tool [名称]` | 创建工具调用线程 |
| `/mode chat` | 将当前线程切换为轻量聊天线程 |
| `/mode tool` | 将当前线程切换为工具调用线程 |
| `/switch [序号\|名称]` | 切换线程 |
| `/rename <新名称>` | 重命名当前线程 |
| `/rename [序号\|名称] <新名称>` | 重命名指定线程 |
| `/close [序号\|名称]` | 关闭线程，只剩一个时会自动创建新线程 |
| `/sessions` | 查看当前 AI 后端的线程 |
| `/cancel` | 取消当前任务并清空队列 |
| `/status` | 查看当前 AI、模型、线程、角色和 SID |
| `/profile` | 查看所有角色 |
| `/profile <名称>` | 将当前线程绑定到指定角色 |
| `/profile off` | 当前默认线程保持默认风格 |
| `/profile add <名称> \| <提示词>` | 添加新角色 |
| `/profile delete <名称>` | 删除角色，若已有绑定会要求二次确认 |
| `/memory` | 查看长期记忆统计和每类前 3 条 |
| `/memory all` | 查看完整长期记忆 |
| `/memory 性格` / `/memory 偏好` / `/memory 事实` | 只查看某一类长期记忆 |
| `/compact` | 手动压缩当前 chat 线程的早期历史 |
| `/cleanup media` | 查看媒体文件统计 |
| `/cleanup media <天数>` | 查看超过指定天数的媒体文件 |
| `/cleanup media confirm <天数>` | 删除超过指定天数的媒体文件 |
| `/help` | 查看帮助 |

## 角色系统

角色模板保存在 `wechat-profiles.json`。线程绑定角色后，该线程会持续使用对应系统提示词；为了避免旧上下文污染，已绑定角色的线程不能直接切换成另一个角色，建议使用 `/new 角色名` 新建线程。

你可以在 GUI 的 Profiles 页面直接编辑角色，也可以手动修改 `wechat-profiles.json`。修改后建议新建线程使用新角色，避免旧会话上下文影响效果。

每轮回复都会注入当前本地时间、星期和大致时段，并提示模型把动作神态限制在微信私聊和已有上下文里。这样凌晨、深夜等场景下会更倾向于安静的手机聊天语境，而不是随意补出喝茶、教室、舞台等不合时宜的动作。

风格提示中也包含轻量术语规范：乐队、角色、作品、歌曲等专有名词优先沿用上下文、角色模板和知识库里的写法，避免临场自造中文音译。术语规则保存在根目录 `wechat-terminology.json`：

- `promptRules`：注入给模型看的称呼规范。
- `replacements`：发送前执行的 JavaScript 正则替换；`pattern` 里的反斜杠需要写成 `\\`。

例如 Pastel*Palettes 使用全名或 PasPale，不使用“帕斯帕雷”等译法；若宫伊芙日常称呼写“伊芙”，不写 Eve/eve。

角色只能主动使用通用 Unicode emoji、普通标点、文字颜文字或少量括号动作。用户发来的 `[旺柴]`、`[捂脸]` 等微信内置表情占位会被理解为表情，但角色回复不应主动发送这类占位文本。

## 长期记忆

长期记忆保存在根目录 `wechat-memory.json`，用于记录用户长期稳定的信息。默认只注入到非默认角色线程；默认角色不使用这份记忆。

记忆分为三类：`trait`（性格/价值观）、`preference`（偏好）、`fact`（事实）。敏感或私密信息会用 `sensitive: true` 标记，注入时提示 AI 只在相关且必要时使用。自动写入器会在普通用户消息后让 AI 判断是否值得记忆，并直接更新正式 `wechat-memory.json`；不确定或只是闲聊时会输出 `noop`。长期学习、练习或培养的技能、乐器、运动、创作习惯通常会作为长期事实候选。

系统不会硬性截断 memory；当单个用户的记忆超过约 60 条，或注入上下文超过约 800-1200 字时，会发消息提醒你手动整理。

## 知识库

`data/knowledge/` 目录包含 Markdown 知识文件。首次使用或修改知识后，运行：

```bat
scripts\rebuild-rag.bat
```

构建结果默认写入 `data/rag_vector_store/`，模型缓存默认写入 `data/.fastembed_cache/`。如果知识库检索异常，可以删除 `data/rag_vector_store/` 后重新运行 `scripts\rebuild-rag.bat`。

查询时会跳过短问候、纯寒暄等低价值检索；绑定角色的线程会在合适情况下把角色名加入查询，以提高召回准确率。

## 附件处理

- **图片**：下载到 `data/inbound_media/`；可按 `vision.mode` 调用外部视觉模型，或把本地路径交给支持视觉的 AI 后端。
- **语音**：保存语音文件，并使用微信返回的语音转文字内容。
- **文件**：保存文件，并尝试抽取 PDF、DOCX、PPTX、XLSX 的文本预览。
- **视频**：保存视频，可用 ffmpeg 截取首帧；首帧同样遵循 `vision.mode`。

图片、视频、文件发送后有 30 秒合并窗口，窗口内追加的文字会作为附件补充说明一起交给 AI。

## GUI

`launch.bat` 启动后会打开 `http://127.0.0.1:18720`。当前 GUI 页面：

| 页面 | 功能 |
|---|---|
| Status | 在线状态、当前 AI、模型、线程数量 |
| Sessions | 查看线程列表和生成 CLI 恢复指令 |
| Profiles | 查看、创建、编辑、删除角色模板 |
| Config | 查看和编辑 `data/config.json` |

GUI 只监听 `127.0.0.1`，默认不对局域网开放。

## 本地数据

每次 AI 调用会在 `data/logs/` 下生成：

- `.jsonl`：原始事件流，适合精确排查。
- `.txt`：可读摘要，包含用户输入、工具调用、结果和错误。

程序还会在本地保存一些运行数据：

| 路径 | 内容 | 说明 |
|---|---|---|
| `data/config.json` | 本机配置 | 保存路径、代理、模型、视觉 API 等设置 |
| `data/wechat-token.json` | 微信登录状态 | 删除后下次启动会重新扫码登录 |
| `data/wechat-sessions.json` | 会话状态 | 保存线程、SID、角色绑定等信息 |
| `wechat-profiles.json` | 角色模板 | 可通过 GUI 或文本编辑器修改 |
| `wechat-memory.json` | 长期记忆 | 可通过 `/memory` 命令或文本编辑器维护 |
| `data/logs/` | AI 调用日志 | 可用于排查问题；会按 `logs.retentionDays` 自动清理 |
| `data/inbound_media/` | 收到的图片、文件、语音、视频 | 可用 `/cleanup media` 或 `scripts\cleanup-media.bat` 清理 |
| `data/rag_vector_store/` | 知识库索引 | 可通过 `scripts\rebuild-rag.bat` 重建 |
| `data/.fastembed_cache/` | embedding 模型缓存 | 首次构建知识库时自动下载和复用 |

升级新版时，通常保留 `data/config.json`、`data/wechat-token.json`、`data/wechat-sessions.json`、`wechat-profiles.json`、`wechat-memory.json` 和自己的 `data/knowledge/` 即可继续使用原来的配置、登录状态、会话、角色和记忆。

## 打赏

如果这个项目对你有帮助，欢迎请我喝杯奶茶 🧋

<p align="center">
  <img src="./docs/assets/sponsor-alipay.jpg" width="220" alt="支付宝收款码" />
</p>

## 许可

MIT
