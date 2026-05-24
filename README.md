# WeChat AI Bot

> v1.0.0 — 在 Windows 本机上运行的微信 AI 助手。监听微信消息，将文字、图片、语音、文件、视频整理后交给 Claude Code 或 Codex 回复，支持多线程会话、角色扮演和本地知识库检索。

## 功能

- **双 AI 后端**：支持 Claude Code 和 Codex，随时切换，各自独立会话
- **多线程会话**：创建、切换、重命名、关闭独立聊天线程
- **角色扮演**：内置长崎素世、千早爱音、丸山彩、白鹭千圣等 BangDream 角色完整设定
- **长度签 + 场景感知**：闲聊自动短回复，任务模式允许结构化长回复，同时保持角色语气
- **多媒体理解**：图片云端视觉识别、文件文本预览（PDF/DOCX/PPTX/XLSX）、视频首帧分析
- **本地知识库**：BangDream 角色知识向量检索，绑定角色线程自动锚定查询
- **日志与排查**：每次 AI 调用生成 JSONL + 人类可读日志，自动清理过期日志

## 依赖

| 依赖 | 用途 | 必需 |
|---|---|---|
| Node.js | 运行主程序 bot.mjs | 是 |
| Python 3 | 文件提取、RAG 向量检索 | 是 |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | AI 后端（CC） | 至少一个 |
| [Codex (OpenAI)](https://github.com/openai/codex) | AI 后端（Codex） | 至少一个 |
| ffmpeg | 视频首帧提取 | 否 |
| SiliconFlow API Key | 图片云端视觉识别 | 否 |

## 快速开始

```bash
# 1. 安装 Node 依赖
npm install

# 2. 安装 Python 依赖
pip install -r requirements-rag.txt

# 3. 复制并编辑配置文件
copy config.example.json config.json
# 编辑 config.json，填入 Claude Code / Codex 路径、SiliconFlow API Key 等

# 4. 构建知识库索引（首次使用）
rebuild-rag.bat

# 5. 启动
start.bat
```

## 配置

复制 `config.example.json` 为 `config.json` 后编辑：

```json
{
  "paths": {
    "npmGlobal": "npm 全局路径",
    "claude": "claude.exe 完整路径",
    "codex": "codex.js 完整路径",
    "ragScript": "rag.py 完整路径"
  },
  "proxy": { "https": "本机代理地址" },
  "vision": {
    "baseUrl": "视觉模型 API 地址",
    "apiKey": "视觉模型 API Key",
    "model": "视觉模型名称"
  },
  "rag": {
    "knowledgeDir": "knowledge",
    "storeDir": "rag_vector_store"
  },
  "logs": { "retentionDays": 30 }
}
```

## 微信命令

| 命令 | 说明 |
|---|---|
| `/cc` | 切换到 Claude Code |
| `/codex` | 切换到 Codex |
| `/new [名称]` | 创建新线程 |
| `/switch [序号\|名称]` | 切换线程 |
| `/rename [序号\|名称] <新名称>` | 重命名线程（空格分隔） |
| `/close [序号\|名称]` | 关闭线程 |
| `/sessions` | 查看所有线程 |
| `/cancel` | 取消当前任务 |
| `/status` | 查看当前 AI、线程、角色 |
| `/profile` | 查看所有角色 |
| `/profile <名称>` | 绑定当前线程到指定角色 |
| `/profile add <名称> \| <提示词>` | 添加新角色 |
| `/profile delete <名称>` | 删除角色（二次确认） |
| `/cleanup media` | 查看媒体文件统计 |
| `/cleanup media <天数>` | 查看超过 N 天的文件 |
| `/cleanup media confirm <天数>` | 确认删除旧媒体文件 |
| `/help` | 查看帮助 |

## 角色扮演

内置四个 BangDream 角色，每个包含完整的背景设定、性格、说话方式、人际关系和任务中的角色表现。将线程绑定到角色后，AI 会以该角色的口吻回复。

聊天时 Bot 通过"长度签"机制随机控制回复篇幅，让对话节奏接近真人私聊。正经求助时会切换到任务模式，允许更长的结构化回复同时保持角色特征。

## 知识库

`knowledge/` 目录包含 BangDream 角色知识库（Markdown 格式），首次使用需运行 `rebuild-rag.bat` 构建向量索引。

绑定角色的线程在查询知识库时会自动以角色名作为前缀锚定，提高语义检索命中率。纯问候语（"早上好""晚安"等）不会触发检索。

编辑知识库文件后需要重新运行 `rebuild-rag.bat` 使更改生效。

## 日志

每次 AI 调用会在 `logs/` 生成两个文件：
- `.jsonl`：原始事件流
- `.txt`：人类可读摘要

日志默认保留 30 天后自动清理，可通过 `config.json` 的 `logs.retentionDays` 调整。

## 许可

MIT License
