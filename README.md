# WeChat AI Bot

> v2.4.0 — Windows 本机运行的微信 AI 助手

WeChat AI Bot 监听微信消息，将文字、图片、语音、文件、视频交给 Claude Code 或 Codex 回复。支持多线程会话、角色扮演、本地知识库和长期记忆。

需要 Node.js 22+，Windows 本机运行。

## 功能

- **双 AI 后端** — `/cc` `/codex` 随时切换，各自保留独立会话
- **多线程** — 创建、切换、重命名、关闭线程，状态持久化，重启可恢复
- **角色扮演** — 内置长崎素世、千早爱音、丸山彩、白鹭千圣四个 BangDream 角色，可自定义
- **长期记忆** — 每个角色独立维护对用户的记忆，自动写入长期信息
- **主动回复** — 角色在合适时机会主动发起消息，经过候选生成和到点二次判断
- **场景氛围** — inner_scenelet 隐藏中间层 + 跨轮轻量 scene_state，角色拥有真实的"此刻状态"
- **知识库** — 本地 Markdown 向量索引，角色对话时自动锚定检索
- **多媒体** — 图片/语音/文件/视频自动下载，图片和视频首帧可接视觉模型描述
- **聊天历史** — 持久化存储，GUI 内按对话浏览、搜索、展开 scenelet
- **本地 GUI** — `http://127.0.0.1:18720`，Status / Sessions / Profiles / History / Config 五个页面

## 快速开始

```bat
scripts\setup.bat
copy app\config.example.json data\config.json
scripts\rebuild-rag.bat
launch.bat
```

启动后按终端提示扫码登录微信，浏览器自动打开 GUI。

## 依赖

| 依赖 | 必需 |
|------|------|
| Node.js 22+ | 是 |
| Python 3 + pip | 是（RAG、文件提取） |
| Claude Code 或 Codex | 至少一个 |
| ffmpeg | 否（视频首帧） |
| OpenAI-compatible 视觉 API | 否（图片/视频描述） |

## 配置

`data/config.json` 从 `app/config.example.json` 复制。以下字段需要关注：

```json
{
  "paths": {
    "claude": "留空则自动从 PATH 查找",
    "codex": "留空则自动从 PATH 查找",
    "workDir": "Claude/Codex 工作目录，默认用户目录"
  },
  "proxy": {
    "https": "共享代理，按需填写 http://127.0.0.1:7892",
    "claudeHttps": "单独为 Claude 设置代理",
    "codexHttps": "单独为 Codex 设置代理",
    "ragHttps": "RAG 脚本代理"
  },
  "vision": {
    "mode": "auto / external / native / off",
    "apiKey": "外部视觉 API Key"
  },
  "models": {
    "claudeFast": "快速模型",
    "claudeFallback": "回退模型",
    "scenelet": "scenelet 专用模型"
  },
  "logs": { "retentionDays": 30 }
}
```

环境变量可覆盖配置：`WECHAT_CLAUDE_PATH`、`WECHAT_CODEX_PATH`、`WECHAT_AI_WORK_DIR`、`WECHAT_HTTPS_PROXY`、`WECHAT_CLAUDE_HTTPS_PROXY`、`WECHAT_CODEX_HTTPS_PROXY`、`WECHAT_RAG_HTTPS_PROXY`、`WECHAT_VISION_MODE`、`WECHAT_VISION_BASE_URL`、`WECHAT_VISION_API_KEY`、`WECHAT_VISION_MODEL`、`WECHAT_LOG_RETENTION_DAYS`。

### AI 后端登录

安装 Claude Code 或 Codex 后，先在普通终端确认能正常进入：

```bat
claude
```

路径通常无需手动填写。

### 知识库

`data/knowledge/` 中的 Markdown 文件构建为本地 Qdrant 向量索引。修改知识后运行：

```bat
scripts\rebuild-rag.bat
```

## 微信命令

| 命令 | 说明 |
|------|------|
| `/cc` `/codex` | 切换 AI 后端 |
| `/new [名称]` | 创建新线程（名称匹配角色名则自动绑定） |
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

角色模板保存在 `wechat-profiles.json`，可通过 GUI 或文本编辑器修改。线程绑定角色后持续使用对应系统提示词；已绑定的线程不能直接换角色，建议 `/new 角色名` 新建。

每轮回复注入当前本地时间和时段，模型会据此调整语境。

## 长期记忆

每个角色独立维护 `wechat-memory.json`（不纳入版本控制，新用户从 `wechat-memory.example.json` 开始）。记忆分 `trait` / `preference` / `fact` 三类，回合结束后由 memory writer 自动判断是否写入。当前消息优先于旧记忆。

## 附件

- **图片** — 下载后按 `vision.mode` 调用外部视觉模型生成描述
- **语音** — 保存文件，使用微信返回的语音转文字
- **文件** — 保存后提取 PDF / DOCX / PPTX / XLSX 文本预览
- **视频** — 保存后可用 ffmpeg 截取首帧描述

发送后有 30 秒合并窗口，期间追加的文字作为附件补充说明。

## 本地数据

| 路径 | 内容 |
|------|------|
| `data/config.json` | 本机配置 |
| `data/wechat-token.json` | 微信登录态（删除后重新扫码） |
| `data/wechat-sessions.json` | 会话状态 |
| `wechat-profiles.json` | 角色模板 |
| `wechat-memory.json` | 长期记忆（不入版本控制） |
| `data/chat-history.json` | 聊天历史（不入版本控制） |
| `data/logs/` | AI 调用日志（`.jsonl` + `.txt`） |
| `data/inbound_media/` | 收到的附件，可用 `scripts\cleanup-media.bat` 清理 |
| `data/rag_vector_store/` | 知识库向量索引 |

升级时保留 `data/config.json`、`data/wechat-token.json`、`data/wechat-sessions.json`、`wechat-profiles.json`、`wechat-memory.json` 和自定义知识库即可。

## GUI

`http://127.0.0.1:18720`，仅监听本机。

| 页面 | 功能 |
|------|------|
| Status | 在线状态、当前 AI、模型 |
| Sessions | 线程列表、CLI 恢复指令 |
| Profiles | 编辑/新增/删除角色模板 |
| History | 聊天历史、按对话浏览、搜索、scenelet 展开 |
| Config | 编辑 `data/config.json` |

## 许可

MIT
