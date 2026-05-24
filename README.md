# WeChat AI Bot

> v1.2.0 — Windows 本机运行的微信 AI 助手

WeChat AI Bot 监听微信消息，将文字、图片、语音、文件、视频整理后交给 Claude Code 或 Codex 回复。支持多线程会话、角色扮演、本地知识库检索和 Web 管理界面。

## 功能

- **双 AI 后端**：Claude Code 和 Codex 自由切换，各自独立会话
- **多线程会话**：创建、切换、重命名、关闭独立聊天线程，重启后保留
- **角色扮演**：内置长崎素世、千早爱音、丸山彩、白鹭千圣等角色完整设定，可自定义
- **回复风格控制**："长度签"随机控制闲聊篇幅（65% 极短/短），"场景感知"区分闲聊与任务模式，任务中允许结构化回复同时保持角色语气
- **多媒体理解**：图片云端视觉识别、文件文本预览（PDF/DOCX/PPTX/XLSX）、视频首帧分析、语音转文字
- **本地知识库**：BangDream 角色向量检索，绑定角色线程自动锚定查询，纯问候语自动跳过
- **Web 管理界面**：本地 GUI（Status / Sessions / Profiles / Config），`launch.bat` 一键启动
- **日志**：每次 AI 调用生成 JSONL + 人类可读日志，默认 30 天自动清理

## 依赖

| 依赖 | 用途 | 必需 |
|---|---|---|
| Node.js 18+ | 主程序 | 是 |
| Python 3 + pip | 文件提取、RAG 向量检索 | 是 |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | AI 后端 | 至少一个 |
| [Codex](https://github.com/openai/codex) | AI 后端 | 至少一个 |
| ffmpeg | 视频首帧提取 | 否 |
| 视觉 API Key（如 SiliconFlow） | 图片云端识别 | 否 |

## 快速开始

```bash
# 1. 安装依赖
setup.bat

# 2. 复制并编辑配置
copy config.example.json config.json
# 编辑 config.json：填入 Claude Code / Codex 路径、视觉 API Key 等

# 3. 构建知识库索引（首次）
rebuild-rag.bat

# 4. 启动
launch.bat
```

启动后扫码登录，浏览器自动打开 `http://127.0.0.1:18720` 进入管理界面。

## 配置

`config.json` 结构（从 `config.example.json` 复制后编辑）：

```json
{
  "paths": {
    "claude": "claude.exe 完整路径",
    "codex": "codex.js 完整路径",
    "ragScript": "rag.py 完整路径"
  },
  "proxy": { "https": "本机代理地址" },
  "models": {
    "claudeFast": "闲聊时使用的快速模型",
    "claudeFallback": "正经问题的 fallback 模型"
  },
  "timeouts": { "aiMs": 600000 },
  "vision": {
    "baseUrl": "视觉模型 API 地址",
    "apiKey": "视觉模型 API Key",
    "model": "视觉模型名称",
    "detail": "high",
    "timeoutMs": 180000
  },
  "rag": {
    "enabled": true,
    "knowledgeDir": "knowledge",
    "embedModel": "BAAI/bge-small-zh-v1.5",
    "topK": 3,
    "minScore": 0.48
  },
  "logs": { "retentionDays": 30 }
}
```

环境变量可覆盖配置：`WECHAT_CLAUDE_PATH`、`WECHAT_CODEX_PATH`、`WECHAT_HTTPS_PROXY`、`WECHAT_VISION_API_KEY`、`WECHAT_LOG_RETENTION_DAYS`。

## 微信命令

| 命令 | 说明 |
|---|---|
| `/cc` | 切换到 Claude Code |
| `/codex` | 切换到 Codex |
| `/new [名称]` | 创建新线程 |
| `/switch [序号\|名称]` | 切换线程 |
| `/rename [序号\|名称] <新名称>` | 重命名线程（空格分隔） |
| `/close [序号\|名称]` | 关闭线程（只剩一个时自动创建新线程） |
| `/sessions` | 查看所有线程 |
| `/cancel` | 取消当前任务 |
| `/status` | 查看当前 AI、模型、线程、角色 |
| `/profile` | 查看所有角色 |
| `/profile <名称>` | 绑定当前线程到指定角色 |
| `/profile add <名称> \| <提示词>` | 添加新角色 |
| `/profile delete <名称>` | 删除角色（二次确认） |
| `/cleanup media` | 查看媒体文件统计 |
| `/cleanup media confirm <天数>` | 确认删除旧媒体文件 |
| `/help` | 查看帮助 |

## 角色系统

四个 BangDream 角色内置完整设定（背景、性格、说话方式、人际关系、任务中的角色表现），从 `wechat-profiles.json` 加载。线程绑定角色后，AI 以该角色口吻回复。

> **注意**：profiles 中的角色 prompt 包含发布者的昵称（"沃沃"），使用前请替换为你自己的称呼。

已绑定角色的线程不能随意切角色——推荐新建线程绑定新角色，避免旧上下文残留。

## 回复风格

通过两层机制控制：

**长度签**（`chooseReplyBudget`）：每轮根据用户输入类型随机抽取长度预算。闲聊 65% 概率极短或短（≤55 字，硬约束）；正经问题大部分正常到较完整（80-320 字，软约束）。超预算时 `constrainCasualReply` 截断。

**场景感知**（`buildStylePrompt`）：`isInfoSeekingTurn` 判断闲聊/任务，给不同风格指令。任务中允许结构化表达，同时强调保持角色语气。

颜文字记忆：最近用过的 8 个颜文字会被记录，下一轮引导 AI 换用。

## 知识库

`knowledge/` 目录包含 BangDream 角色知识（Markdown），首次使用需 `rebuild-rag.bat` 构建向量索引。

绑定角色的线程查询时自动以角色名锚定（如 `"长崎素世 用户消息"`），提高语义检索命中率。纯问候语（"早上好""晚安""哈哈"等）自动跳过检索。

编辑知识库后需重新 `rebuild-rag.bat`。

## 附件处理

- **图片**：下载 → 云端视觉模型生成中文描述 → 交给 AI（区分"看清楚的事实"和"不确定推测"）
- **文件**：保存本地，对 PDF/DOCX/PPTX/XLSX 提取文本预览（PDF 前 8 页、PPTX 前 20 张、XLSX 前 8 个 sheet）
- **视频**：保存本地，ffmpeg 截取首帧 → 视觉模型描述
- **语音**：保存本地，微信自带语音转文字一并发送

图片/视频/文件发送后有 30 秒合并窗口，窗口内跟上的文字作为附件补充说明一起交给 AI。

## 日志

每次 AI 调用生成两个文件：
- `.jsonl`：原始事件流（精确排查）
- `.txt`：人类可读摘要（用户输入、工具调用、结果、错误）

默认保留 30 天自动清理。`logs.retentionDays: 0` 关闭自动清理。媒体文件不会自动删除，需 `/cleanup media` 或 `cleanup-media.bat` 手动清理。

## GUI

`launch.bat` 启动后自动打开 `http://127.0.0.1:18720`，四个面板：

| 面板 | 功能 |
|---|---|
| Status | 在线状态、当前 AI、模型、会话数 |
| Sessions | 查看所有会话、生成 CLI 恢复指令 |
| Profiles | 查看/创建/编辑/删除角色模板 |
| Config | 可视化编辑全部 config.json 字段 |

## 许可

MIT
