# Changelog

## v1.2.0 — GUI (2026-05-25)
- Local web UI at `http://127.0.0.1:18720` with 4 panels: Status, Sessions, Profiles, Config
- Auto-opens browser after bot startup
- `launch.bat` — unified entry; `setup.bat` — one-click install
- Removed old DEFAULT_PROFILES (毒舌/老师/简洁); profiles loaded from `wechat-profiles.json`

## v1.1.0 — Code Splitting (2026-05-25)
- Extracted 6 modules from monolithic `bot.mjs`:
  - `lib/config.mjs` — config loading and accessors
  - `lib/state.mjs` — centralized mutable state
  - `lib/utils.mjs` — shared helpers (uuid, log, sleep)
  - `lib/wechat.mjs` — WeChat API, login, send
  - `lib/reply.mjs` — reply formatting, length budget, kaomoji
  - `lib/rag.mjs` — RAG query, skip logic

## v1.1.0 — Earlier (2026-05-24~25)
- `/close` auto-creates new thread when closing last one
- `/close` switches to previous thread, shows current thread name
- `/rename` uses spaces instead of `|` separator
- Startup self-check (Claude, Codex, Python, ffmpeg, RAG, Vision, deps)
- `/cleanup media` command + `cleanup-media.bat`
- RAG always anchors queries with bound profile name
- Enriched character profiles with full background, task-mode behavior
- `buildStylePrompt` differentiates casual vs task mode
- Knowledge base: added Soyo vegetable juice + health management

## v1.0.0 — Initial Release (2026-05-25)
- WeChat AI Bot with Claude Code and Codex backends
- Multi-thread session management
- Character role-play (长崎素世, 千早爱音, 丸山彩, 白鹭千圣)
- Image/video/file/voice processing
- Local BangDream knowledge base (RAG)
- Reply length budget ("长度签") + casual/task style differentiation
