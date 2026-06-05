# Changelog

## v2.5.0 — Searchable Scenelet, Prompt Pipeline & Voice ASR (2026-06-05)
- Switch production scenelet generation to the **non-bare searchable scenelet** architecture by default: `inner_scenelet` hidden calls can use `WebSearch/WebFetch` for public facts, while proactive and daily-share hidden checks remain lightweight bare JSON calls.
- Add `scene.sceneletBare` config switch so users can revert scenelet calls to bare mode without changing code.
- Version the GUI prompt defaults in `data/prompts.json`, making the roleplay/prompt pipeline shareable as an open prompt-writing example instead of purely local runtime config.
- Expand and tune the prompt pipeline: richer character life scenes, public-fact boundaries, scenelet-to-WeChat bridge guidance, daily-share proactive prompts, and stronger safeguards against native WeChat bracket emoji placeholders.
- Add **daily_share** proactive candidates for low-pressure everyday topic starts, and improve proactive intent deduplication so repeated turns about the same pending topic merge instead of stacking duplicate scheduled messages.
- Count proactive daily limits by actually sent messages, not merely generated candidate intents.
- Remove the artificial six-message social reply split cap; replies still respect the WeChat byte limit but no longer merge natural message beats just to stay under six parts.
- Add WhisperX voice transcription pipeline: WeChat `.silk` voice files are decoded with `silk-wasm`, converted to WAV, then transcribed through a configurable WhisperX Python environment, with WeChat's built-in transcript kept as fallback.
- Add `voice.*` config fields and startup checks for optional WhisperX support.
- Improve GUI Proactive and Prompts surfaces, including clearer runtime pipeline text and less noisy proactive display.
- Add offline evaluation scripts for roleplay smoke tests, search architecture comparison, tool-use probing, reply length/bridge checks, and readable experiment reports.
- Update README and release packaging so versioned prompt defaults are included in GitHub release archives.

## v2.4.0 — Scenelet, Proactive Reply & Character Overhaul (2026-06-02)
- Add **inner_scenelet** hidden middle layer: every character chat turn first runs an independent model call to generate a vivid, in-character inner scenelet (current life moment, physical state, emotional tone, why this reply feels natural) that guides the main reply but is never shown to the user
- Add **scene_state** lightweight cross-turn continuity: only a very short 40-80 character state (time, place, body state, topic aftertaste) carries between turns with a 2-hour expiry, replacing unlimited Claude session history
- Add **proactive reply** mechanism: scenelet generation can produce one-shot proactive candidates with scheduled_at/expires_at/cancel_if; a second-check evaluation at the scheduled time decides whether to send; only active character sessions are scanned, busy/idle/merging sessions are skipped, 1-hour cooldown between proactive messages
- Add **chat history** storage (`app/lib/chat-history.mjs`) with persistent JSON backend and GUI History tab showing conversations, searchable messages, and expandable inner scenelet blocks
- Add `models.scenelet` config field for independent scenelet model selection
- Enable `--no-session-persistence` for character chats, keeping only 6-8 turns of visible context managed by the bot instead of unbounded Claude session history
- Overhaul all 4 character profiles: add **生活世界** (daily life as ordinary students with realistic routines), add **事实与细节边界** (lore fact boundaries), expand **说话方式** with WeChat casual style guidance transferred from the slimmed global style prompt
- Slim global style prompt from ~600 to ~100 characters, removing constraints now covered by per-profile speaking style and inner_scenelet atmosphere
- Remove failed-turn guard text from the transient prompt body
- Remove chat-history storage cap (previously 10,000 events)
- Update Chisato profile: broader daily life, Kanon not always at home, Aya expanded beyond romantic tension, WeChat tone refinements

## v2.3.1 — RAG Trigger & Cleanup (2026-06-01)
- Relax RAG trigger: add "你/自己 + question words" path so conversational probing about the character (without explicit lore keywords or name mention) still triggers knowledge base lookup
- Remove dead code: unused imports, unreferenced functions, orphaned GUI routes (rag/media/logs/control), and the chat-mode rhetorical pattern detection system
- Fix CDN_BASE_URL ReferenceError on messages with attachments

## v2.3.0 — Per-Role Memory (2026-06-01)
- Restructure long-term memory into per-role buckets (`users[userId].roles[profile].items`) so each role persona maintains its own independent memory of the user, with automatic migration of existing memory into the 白鹭千圣 role
- Add `/memory <角色名>` to view another role's memory from any session; `/memory` without arguments shows the current role
- Remove chat/tool session mode split, `/mode`, `/compact`, `/summary` commands, and the OpenAI-compatible chat backend — all threads now use Claude Code / Codex persistent sessions
- Retire `wechat-memory.json` from public tracking and add `wechat-memory.example.json` as the v2 template for new installations
- Add automatic retry (up to 3 attempts) on message send failures for improved reliability
- Remove `DEFAULT_CHAT_CC_SESSIONS`, `defaultSessionMode`, and related chat-mode state from the codebase
- Clean up chat-related GUI fields, session mode columns, and config entries

## v2.2.0 — Chat and Tool Session Split (2026-05-31)
- Add per-session `chat` / `tool` modes. Tool sessions keep using Claude Code/Codex resume for project work, while chat sessions use a lightweight OpenAI-compatible Chat Completions backend.
- Show the session mode in WeChat reply headers, `/sessions`, `/status`, and the local GUI Sessions page.
- Add `/new chat`, `/new tool`, and `/mode chat|tool` commands; existing `cc` sessions named `cst`, `anon`, `soyo`, and `aya` migrate to chat mode, while other sessions stay in tool mode.
- Preserve full chat history by default and add manual `/compact` for chat sessions, storing an early-history summary while keeping recent turns.
- Seed migrated chat sessions from existing readable logs so role conversations can continue after configuring the chat API.
- Add `chat.*` GUI/config fields for OpenAI-compatible chat API settings and compact behavior.
- Prevent image/video prompts from encouraging Claude Code to read local media files as base64 when an external visual description is already available.
- Add prompt guidance so role replies do not actively send WeChat built-in emoji placeholders such as `[旺柴]`.

## v2.1.1 — Memory and Chat Polish (2026-05-28)
- Change `/memory` into a summary view with per-category counts and up to 3 sample items; add `/memory all` and `/memory 性格|偏好|事实` category views
- Improve automatic memory candidate detection for long-term learning and practice statements, such as learning or practicing an instrument
- Remove keyword-based memory prefiltering so the AI memory writer judges ordinary user turns directly and writes accepted items to the formal memory file
- Add a local chat reality prompt with current local time, weekday, time period, and softer action guidance for context-appropriate roleplay gestures
- Add root-level `wechat-terminology.json` for editable terminology prompt rules and final-output normalization, including unwanted PasPale Chinese transliterations and Eve naming

## v2.1.0 — Memory and Project Layout (2026-05-28)
- Add structured long-term user memory in `wechat-memory.json`, with manual `/memory` commands, sensitive item marking, soft maintenance reminders, and non-default profile prompt injection
- Add an independent memory writer that only records long-term user traits, preferences, and facts when user messages meet the memory threshold
- Reorganize the project so user-facing root files stay focused on `launch.bat`, `README.md`, `wechat-profiles.json`, and `wechat-memory.json`; runtime code, data, scripts, docs, and GitHub workflows now live in dedicated folders
- Move private runtime state to `data/` and keep token, session, logs, media, vector store, model cache, and temporary prompt files out of public release artifacts
- Relax kaomoji memory into a short cooldown instead of a long suppression list, and improve detection for additional common kaomoji
- Update profile prompts with optional non-canon romantic subtext for Soyo/Anon and Chisato/Aya while preserving existing profile content

## v2.0.4 — Remove hard reply truncation (2026-05-25)
- Remove `constrainCasualReply` hard truncation from the reply pipeline; AI output is no longer forcibly cut off to fit the random length budget
- Change length budget prompt from hard constraint ("硬约束") to soft style guidance ("风格指引"), so the AI can naturally exceed the suggested length when needed

## v2.0.3 — GUI polish and startup fixes (2026-05-25)
- Add `vision.mode` (`auto` / `external` / `native` / `off`) so users with vision-capable Claude Code/Codex backends can skip the external vision API
- Auto-detect `claude` and `codex` from PATH before falling back to common npm global install paths
- Treat placeholder config strings as unset, reducing first-run setup friction
- Make proxy, RAG script, AI working directory, and external vision API key optional in the example config
- Add README setup notes for AI backend login, vision mode, proxy, custom knowledge base, and AI working directory
- Update the GUI Config page with a vision mode selector and optional-field placeholders
- Make single-instance startup open the existing GUI instead of failing, and add restart/open options to `launch.bat`
- Stop the bot when the GUI port is already in use so it does not keep running without a visible UI
- Redesign the local GUI with a sidebar layout, clearer status/session/profile/config panels, and a larger profile editor
- Show resume commands as individual copyable command rows in the Sessions page

## v2.0.2 — Release Hardening (2026-05-25)
- Harden local GUI static file serving and dynamic API route matching
- Fix RAG GUI status and startup metadata lookup for `rag_meta.json`
- Make AI working directory configurable through `paths.workDir` / `WECHAT_AI_WORK_DIR`
- Avoid personal machine path defaults in runtime command execution
- Improve GUI config save validation, API key preservation, and atomic writes
- Escape GUI-rendered session/profile/config text to reduce injection risk
- Align package metadata, scripts, license, README, changelog, and release archive contents
- Keep Windows launch scripts portable while preserving a Program Files Node.js fallback

## v2.0.1 — CI Fix (2026-05-25)
- Use Node.js 22 in CI because `import.meta.dirname` requires Node.js 21.2+

## v2.0.0 — GUI, Code Splitting, CI, and Release Packaging (2026-05-25)
- Local web UI at `http://127.0.0.1:18720` with 4 panels: Status, Sessions, Profiles, Config
- Auto-opens browser after bot startup
- `launch.bat` — unified entry; `setup.bat` — one-click install
- Removed old DEFAULT_PROFILES (毒舌/老师/简洁); profiles loaded from `wechat-profiles.json`
- Extracted modules under `lib/` for config, state, WeChat API, replies, RAG, GUI routes, and static server
- GitHub Actions CI and release archive workflow

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
