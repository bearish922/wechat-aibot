const api = async (method, path, body) => {
  const opts = { method, headers: body ? { "Content-Type": "application/json" } : {} };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  return r.json();
};
const get = path => api("GET", path);
const post = (path, body) => api("POST", path, body);
const del = (path, body) => api("DELETE", path, body);

let activeTab = "status";
const content = document.getElementById("content");
const tabs = document.querySelectorAll("nav button");

tabs.forEach(btn => {
  btn.addEventListener("click", () => {
    tabs.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeTab = btn.dataset.tab;
    render();
  });
});

function toast(msg, ok = true) {
  const el = document.createElement("div");
  el.className = `toast ${ok ? "toast-ok" : "toast-err"}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

async function render() {
  content.innerHTML = '<div class="panel"><p>Loading...</p></div>';
  try {
    switch (activeTab) {
      case "status": await renderStatus(); break;
      case "prompts": await renderPrompts(); break;
      case "history": await renderHistory(); break;
      case "proactive": await renderProactive(); break;
      case "memory": await renderMemory(); break;
      case "config": await renderConfig(); break;
    }
  } catch (e) {
    content.innerHTML = `<div class="panel"><p class="error-text">Error: ${escHtml(e.message)}</p></div>`;
  }
}

// Status (merged with Sessions)
async function renderStatus() {
  const s = await get("/api/status");
  const d = await get("/api/sessions");
  const rows = d.sessions.map(s => `
    <tr>
      <td><span class="badge badge-${s.ai === 'cc' ? 'cc' : 'codex'}">${s.ai === 'cc' ? 'CC' : 'Codex'}</span></td>
      <td>${s.active ? '<span class="badge badge-cc" style="margin-right:6px">Active</span>' : ''}${escHtml(s.name)}</td>
      <td><span class="badge badge-default">${escHtml(s.profile)}</span></td>
      <td>${s.busy ? 'Busy' : s.queue ? 'Queue(' + Number(s.queue) + ')' : 'Idle'}</td>
    </tr>
  `).join("");

  const resume = await get("/api/sessions/resume");
  const resumeCommands = resumeCommandList(resume);

  content.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Status</h2>
        <span class="status-pill ${s.online ? 'online' : 'offline'}">${s.online ? 'Online' : 'Offline'}</span>
      </div>
      <div class="stat-grid">
        <div class="stat-tile"><span>AI</span><strong>${s.currentAI === 'cc' ? 'Claude Code' : 'Codex'}</strong></div>
        <div class="stat-tile"><span>Model</span><strong>${escHtml(s.currentModel)}</strong></div>
        <div class="stat-tile"><span>CC Sessions</span><strong>${Number(s.sessions?.cc || 0)}</strong></div>
        <div class="stat-tile"><span>Codex Sessions</span><strong>${Number(s.sessions?.codex || 0)}</strong></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Sessions (${d.currentAI === 'cc' ? 'Claude Code' : 'Codex'})</h2></div>
      <div class="table-wrap"><table>
        <thead><tr><th>AI</th><th>Name</th><th>Profile</th><th>Status</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4">No sessions</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Resume Commands</h2></div>
      ${renderResumeCommands(resumeCommands)}
    </div>
  `;
  content.querySelectorAll('[data-action="copy-resume"]').forEach(btn => {
    btn.addEventListener("click", () => copyResumeCommand(btn));
  });
}

function resumeCommandList(resume) {
  if (Array.isArray(resume?.commands)) return resume.commands.filter(x => x?.command);
  const items = [];
  let aiLabel = "";
  let name = "";
  let profile = "";
  let active = false;
  for (const rawLine of String(resume?.text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("## ")) {
      aiLabel = line.slice(3).trim();
      name = "";
      profile = "";
      active = false;
      continue;
    }
    if (/^(claude\s+--resume|codex\s+resume)\s+/.test(line)) {
      items.push({ aiLabel, name, profile, active, command: line });
      continue;
    }
    const role = line.match(/^(?:角色|Profile):\s*(.+)$/i);
    if (role) {
      profile = role[1].trim();
      continue;
    }
    if (!line.startsWith("#")) {
      active = /\[(当前|current)\]/i.test(line);
      name = line.replace(/\s*\[(当前|current)\]\s*$/i, "").trim();
    }
  }
  return items;
}

function renderResumeCommands(commands) {
  if (!commands.length) return '<p class="empty-text">No resume commands</p>';
  return `
    <div class="resume-list">
      ${commands.map((item, index) => `
        <div class="resume-item">
          <div class="resume-meta">
            <span class="badge badge-${item.ai === 'cc' ? 'cc' : item.ai === 'codex' ? 'codex' : 'default'}">${escHtml(item.aiLabel || item.ai || 'AI')}</span>
            <strong>${escHtml(item.name || `Session ${index + 1}`)}</strong>
            ${item.active ? '<span class="resume-current">Current</span>' : ''}
            ${item.profile ? `<span class="resume-profile">${escHtml(item.profile)}</span>` : ''}
          </div>
          <code class="resume-command">${escHtml(item.command)}</code>
          <button class="btn resume-copy" data-action="copy-resume" data-command="${escAttr(item.command)}">Copy</button>
        </div>
      `).join("")}
    </div>
  `;
}

async function copyResumeCommand(btn) {
  const command = btn.dataset.command || "";
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(command);
    } else {
      copyTextFallback(command);
    }
    btn.textContent = "Copied";
    toast("Command copied");
    setTimeout(() => { btn.textContent = "Copy"; }, 1400);
  } catch {
    copyTextFallback(command);
    btn.textContent = "Copied";
    toast("Command copied");
    setTimeout(() => { btn.textContent = "Copy"; }, 1400);
  }
}

function copyTextFallback(text) {
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.left = "-9999px";
  document.body.appendChild(el);
  el.select();
  document.execCommand("copy");
  el.remove();
}

// Prompts
function toS(ms) { return Math.round((ms || 0) / 1000); }
function fromS(s) { return (s || 0) * 1000; }

async function renderPrompts() {
  const [pd, pf] = await Promise.all([get("/api/prompts"), get("/api/profiles")]);
  const p = pd.prompts || {};
  const profiles = pf.profiles || [];
  // Initialize RAG keyword edits from server data (if no pending local edits)
  if (!window._ragKwEdits || Object.keys(window._ragKwEdits).length === 0) {
    window._ragKwEdits = JSON.parse(JSON.stringify(p.ragKeywords || {}));
  }

  const profileRows = profiles.map(pr => `
    <tr>
      <td class="profile-name"><strong>${escHtml(pr.name)}</strong></td>
      <td class="prompt-preview"><span class="prompt-preview-text">${escHtml(pr.prompt)}</span></td>
      <td>${Number(pr.bindings)} session${pr.bindings !== 1 ? 's' : ''}</td>
      <td class="actions-cell">
        <button class="btn" data-action="edit-profile" data-profile="${escAttr(pr.name)}">Edit</button>
        ${pr.name !== '默认' ? `<button class="btn btn-danger" data-action="delete-profile" data-profile="${escAttr(pr.name)}">Del</button>` : ''}
      </td>
    </tr>
  `).join("");

  content.innerHTML = renderPromptsPipeline(p, profileRows);

  content.querySelectorAll('[data-action="edit-profile"]').forEach(btn => {
    btn.addEventListener("click", () => editProfile(btn.dataset.profile));
  });
  content.querySelectorAll('[data-action="delete-profile"]').forEach(btn => {
    btn.addEventListener("click", () => deleteProfile(btn.dataset.profile));
  });

  content.querySelectorAll('.prompts-editable').forEach(el => {
    el.addEventListener('input', () => {
      if (el.tagName === "TEXTAREA" && el.dataset.key) {
        promptDrafts[el.dataset.key] = el.value;
      }
      showSaveBar();
    });
    el.addEventListener('change', () => {
      if (el.tagName === "TEXTAREA" && el.dataset.key) {
        promptDrafts[el.dataset.key] = el.value;
      }
      showSaveBar();
    });
  });
  content.querySelectorAll('[data-action="edit-text"]').forEach(btn => {
    btn.addEventListener("click", () => {
      promptsEditing[btn.dataset.key] = true;
      renderPrompts();
    });
  });
  content.querySelectorAll('[data-action="cancel-text"]').forEach(btn => {
    btn.addEventListener("click", () => {
      delete promptDrafts[btn.dataset.key];
      promptsEditing[btn.dataset.key] = false;
      renderPrompts();
    });
  });
  content.querySelectorAll('[data-action="save-text"]').forEach(btn => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.key;
      const el = content.querySelector(`#prompt_${key}`);
      if (el) {
        promptDrafts[key] = el.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        showSaveBar();
      }
      promptsEditing[key] = false;
      await savePrompts();
      renderPrompts();
    });
  });
  content.querySelector("#promptsSaveBtn")?.addEventListener("click", savePrompts);

  // RAG keyword tab switching
  content.querySelectorAll('[data-kwgroup]').forEach(btn => {
    btn.addEventListener("click", () => {
      window._ragKwActiveGroup = btn.dataset.kwgroup;
      window._ragKwEditingIdx = undefined;
      renderPrompts();
    });
  });
  // RAG keyword chip: delete
  content.querySelectorAll('[data-action="kw-delete"]').forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.kwidx);
      const activeGroup = window._ragKwActiveGroup || "lore";
      const current = getRagKw(activeGroup);
      current.splice(idx, 1);
      setRagKw(activeGroup, current);
      showSaveBar();
      renderPrompts();
    });
  });
  // RAG keyword chip: edit (start inline edit)
  content.querySelectorAll('[data-action="kw-edit"]').forEach(btn => {
    btn.addEventListener("click", () => {
      window._ragKwEditingIdx = Number(btn.dataset.kwidx);
      renderPrompts();
    });
  });
  // RAG keyword: save inline edit (Enter key or OK button)
  content.querySelectorAll('[data-action="kw-save-inline"]').forEach(el => {
    const handler = () => {
      const idx = Number(el.dataset.kwidx);
      const activeGroup = window._ragKwActiveGroup || "lore";
      const input = content.querySelector(`.rag-kw-chip-input[data-kwidx="${idx}"]`);
      const newVal = (input?.value || "").trim();
      if (newVal) {
        const current = getRagKw(activeGroup);
        current[idx] = newVal;
        setRagKw(activeGroup, current);
        showSaveBar();
      }
      window._ragKwEditingIdx = undefined;
      renderPrompts();
    };
    if (el.tagName === "INPUT") {
      el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); handler(); } });
    } else {
      el.addEventListener("click", handler);
    }
  });
  // RAG keyword: add new
  content.querySelectorAll('[data-action="kw-add"]').forEach(input => {
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        const val = input.value.trim();
        if (!val) return;
        const activeGroup = window._ragKwActiveGroup || "lore";
        const current = getRagKw(activeGroup);
        current.push(val);
        setRagKw(activeGroup, current);
        showSaveBar();
        input.value = "";
        renderPrompts();
      }
    });
  });
}

function showSaveBar() {
  const bar = content.querySelector("#promptsSaveBar");
  if (bar) bar.style.display = "flex";
}

function switchTab(name) {
  tabs.forEach(b => b.classList.remove("active"));
  const target = document.querySelector(`nav button[data-tab="${name}"]`);
  if (target) target.classList.add("active");
  activeTab = name;
  render();
}

function renderPipelineInfo(label, desc, techNote, flowLabel, flowSrc, type) {
  return `
    <div class="pipeline-row">
      <div class="pipeline-left">
        <div class="pipeline-field">
          <div class="pipeline-field-head">
            <span class="pipeline-field-label">${escHtml(label)}</span>
            <span class="pipeline-field-desc">${desc}</span>
          </div>
          <span class="pipeline-tech-note">${escHtml(techNote)}</span>
        </div>
      </div>
      <div class="pipeline-connector"><span>─</span></div>
      <div class="pipeline-right">
        <div class="pipeline-node pipeline-node-${type}">
          <span class="pipeline-node-label">${escHtml(flowLabel)}</span>
          <span class="pipeline-node-src">${escHtml(flowSrc)}</span>
        </div>
      </div>
    </div>
  `;
}

let promptsEditing = {};
let promptDrafts = {};

function renderPromptsPipeline(p, profileRows) {
  const profileTable = `
    <div class="pipeline-embedded-table">
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Prompt Preview</th><th>Sessions</th><th></th></tr></thead>
        <tbody>${profileRows || '<tr><td colspan="4">No profiles</td></tr>'}</tbody>
      </table></div>
      <div class="pipeline-table-actions">
        <button class="btn btn-primary" onclick="showAddProfile()">+ Add Profile</button>
        <div id="profileForm"></div>
      </div>
    </div>`;

  return `
    <div class="panel">
      <div class="panel-head">
        <h2>Runtime Prompt Pipeline</h2>
        <span class="status-pill online">Live config</span>
      </div>
      <div class="pipeline-summary">
        <span>Ordered from WeChat input to post-turn persistence.</span>
        <span>Editable controls write through <code>data/prompts.json</code>, profile templates, Memory, and History surfaces.</span>
      </div>
    </div>

    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-input"><span>Phase 0 — Inbound, Session, Attachment</span><span class="pipeline-tag">before processTurn()</span></div>
        ${renderPipelineStep({
          n: 1,
          title: "WeChat Inbound Poll",
          desc: "iLink update arrives, message enters the active session queue, then sessionLoop() calls processTurn().",
          observe: "Status tab, runtime logs, queue/busy fields",
          control: "Read-only in Prompts",
          source: "getUpdates → sessionLoop",
          type: "input",
          body: renderPipelineMeta(["failed/test turns stay out of completed visible context", "new messages can cancel stale proactive intents"]),
        })}
        ${renderPipelineStep({
          n: 2,
          title: "Session Profile Binding",
          desc: "The active session profile selects the role template and decides whether roleplay-only context layers run.",
          observe: "Profiles table and active session bindings",
          control: "Edit role templates here; bind sessions in Sessions",
          source: "wechat-profiles.json",
          type: "sys",
          wide: true,
          body: profileTable,
        })}
        ${renderPipelineStep({
          n: 3,
          title: "Inbound Attachment / Vision Caption",
          desc: "If the user sends an image, Vision runs before the text turn; RAG is skipped for attachment turns.",
          observe: "Turn log includes image/caption context",
          control: "Vision caption prompt",
          source: "visionCaptionPrompt",
          type: "input",
          body: renderTextPreview("visionCaptionPrompt", p.visionCaptionPrompt),
        })}
        ${renderPipelineStep({
          n: 4,
          title: "Failed Turn Guard",
          desc: "Only successful turns advance session state; failed turns are retained separately for retry context and not written as normal chat history.",
          observe: "History tab and data/logs turn results",
          control: "Read-only in Prompts",
          source: "_lastFailedTurn",
          type: "input",
          body: renderPipelineMeta(["success required before visible history, scene_state, proactive candidates, and memory writer are updated"]),
        })}
      </div>
    </div>

    ${renderPipelineArrow("processTurn() begins: profile, style prompt, memory prompt, and logs are prepared")}

    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-sys"><span>Phase 1 — Stable System Context</span><span class="pipeline-tag">system prompt file / Codex prompt prefix</span></div>
        ${renderPipelineStep({
          n: 5,
          title: "Profile Template + Pinned Rules",
          desc: "Role template is joined with profile-specific model rules from knowledge/05_模型规则 when a non-default profile is active.",
          observe: "Profile preview plus pinned-rule file source",
          control: "Profile editor; pinned rule files remain file-backed",
          source: "profileTemplates + 05_模型规则",
          type: "sys",
          body: renderPipelineMeta(["profileRuleMaxChars: 1400 chars", "default profile skips roleplay-only layers"]),
        })}
        ${renderPipelineStep({
          n: 6,
          title: "Long-term Memory Injection",
          desc: "renderMemoryPrompt() selects stable memories by userId + profile and injects them before the model reply.",
          observe: "Memory tab and memory prompt char counts in turn logs",
          control: "Memory context instruction and retrieval limits",
          source: "wechat-memory.json",
          type: "sys",
          body: `
            ${renderTextPreview("memoryContextInstruction", p.memoryContextInstruction)}
            ${renderControlGrid([
              renderNumberControl("memoryDefaultLimit", "Default Limit", p.memoryDefaultLimit || 6, 1, 30, "items"),
            ])}
          `,
        })}
        ${renderPipelineStep({
          n: 7,
          title: "Stable Chat Style",
          desc: "buildStableStylePrompt() appends chat style and expression capability to the stable system layer.",
          observe: "turn_context stableSystemChars",
          control: "Chat style and expression prompt",
          source: "reply.mjs / prompts.json",
          type: "sys",
          body: `
            <label class="pipeline-sub-label">Chat Style</label>
            ${renderTextPreview("chatStyle", p.chatStyle)}
            <label class="pipeline-sub-label">Expression Capability</label>
            ${renderTextPreview("expressionCapability", p.expressionCapability)}
          `,
        })}
      </div>
    </div>

    ${renderPipelineArrow("Roleplay context branch runs before main model when the active profile is not default")}

    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-body"><span>Phase 2 — Roleplay Context Branch</span><span class="pipeline-tag">scenelet + RAG gates</span></div>
        ${renderPipelineStep({
          n: 8,
          title: "Visible Context Window",
          desc: "recentVisibleContext() reads the latest visible chat turns for hidden scenelet and proactive evaluation.",
          observe: "History tab and _visibleHistory",
          control: "Visible context instruction and turn count",
          source: "chatHistoryIntro / visibleContextTurns",
          type: "body",
          body: `
            ${renderTextPreview("chatHistoryIntro", p.chatHistoryIntro)}
            ${renderControlGrid([
              renderNumberControl("visibleContextTurns", "Visible Turns", p.visibleContextTurns || 8, 1, 30, "turns"),
            ])}
          `,
        })}
        ${renderPipelineStep({
          n: 9,
          title: "Carried Scene State",
          desc: "sceneStateText() reads the previous lightweight scene_state, drops it after expiry, then later writes the next state only on success.",
          observe: "History tab scene_state fields",
          control: "Intro text and max chars",
          source: "_sceneState",
          type: "body",
          body: `
            ${renderTextPreview("sceneStateIntro", p.sceneStateIntro)}
            ${renderControlGrid([
              renderNumberControl("sceneStateMaxChars", "Max Chars", p.sceneStateMaxChars || 220, 50, 2000, "chars"),
            ])}
            ${renderPipelineMeta(["current TTL: 2h, read-only in this tab"])}
          `,
        })}
        ${renderPipelineStep({
          n: 10,
          title: "Hidden Inner Scenelet Call",
          desc: "generateSceneletForTurn() calls a hidden JSON prompt to produce inner_scenelet, next_scene_state, and proactive candidates.",
          observe: "History tab scenelet column and data/logs inner_scenelet events",
          control: "Scenelet instructions and inner_scenelet injection intro",
          source: "sceneletInstructions",
          type: "body",
          body: `
            <label class="pipeline-sub-label">Scenelet System Prompt</label>
            ${renderTextPreview("sceneletInstructions", p.sceneletInstructions)}
            <label class="pipeline-sub-label">Inner Scenelet Intro</label>
            ${renderTextPreview("innerSceneletIntro", p.innerSceneletIntro)}
          `,
        })}
        ${renderPipelineStep({
          n: 11,
          title: "RAG Eligibility Gate",
          desc: "RAG runs only when enabled, message has no attachment, profile is non-default, casual-skip is false, and explicit profile/name/lore keywords match.",
          observe: "turn_context ragChars plus RAG hit/miss log lines",
          control: "Lore/name keywords and retrieval parameters",
          source: "shouldUseRagForTurn()",
          type: "body",
          body: `
            ${renderPipelineMeta(["shouldSkipRag() casual greetings: read-only", "explicit other profile name: automatic trigger", "invalid keyword regex is logged and skipped"])}
            ${renderRagKeywordChips(p)}
            <label class="pipeline-sub-label">RAG Context Instruction</label>
            ${renderTextPreview("ragContextInstruction", p.ragContextInstruction)}
            ${renderControlGrid([
              renderNumberControl("ragTopK", "Top-K", p.ragTopK || 6, 1, 20, "docs"),
              renderNumberControl("ragMinScore", "Min Score", p.ragMinScore || 0.48, 0, 1, "score", { step: "0.01" }),
              renderNumberControl("ragResultMaxChars", "Max Chars", p.ragResultMaxChars || 3600, 500, 10000, "chars"),
              renderNumberControl("ragTimeoutMs", "Timeout", toS(p.ragTimeoutMs), 5, 120, "s", { ms: true }),
            ])}
          `,
        })}
      </div>
    </div>

    ${renderPipelineArrow("Turn Body is assembled in exact order: chat reality → scene context → RAG context → timestamped user message")}

    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-model"><span>Phase 3 — Main Model Turn</span><span class="pipeline-tag">Claude stream-json / Codex json</span></div>
        ${renderPipelineStep({
          n: 12,
          title: "Chat Reality + User Message",
          desc: "buildTurnBody() prepends chat reality rules and appends the current local timestamp with the raw user body.",
          observe: "turn_context transientBodyChars",
          control: "Chat reality rules",
          source: "buildTurnBody()",
          type: "model",
          body: renderTextPreview("chatRealityInstructions", p.chatRealityInstructions),
        })}
        ${renderPipelineStep({
          n: 13,
          title: "Backend Prompt Assembly",
          desc: "Claude writes stable context to --append-system-prompt-file; Codex prefixes the same stable context and adds RAG before the prompt.",
          observe: "data/logs turn_context and CLI event stream",
          control: "All upstream prompt controls in this page",
          source: "runClaudeStream() / runCodexStream()",
          type: "model",
          body: renderPipelineMeta(["Claude receives RAG inside stdin body", "Codex receives RAG before the combined prompt", "profile chats use no-session-persistence"]),
        })}
        ${renderPipelineStep({
          n: 14,
          title: "Streaming Flush, Split, Send",
          desc: "Assistant text streams into a buffer, flushes during tool use or long output, then final role chats are split into natural WeChat messages.",
          observe: "WeChat sent chunks and formatted turn log",
          control: "Read-only in Prompts",
          source: "flush() → splitSocialReply() → sendMessage()",
          type: "post",
          body: renderPipelineMeta(["splitText() enforces MAX_REPLY_LEN", "final successful role replies append / on the last chunk"]),
        })}
      </div>
    </div>

    ${renderPipelineArrow("Only successful turns advance durable local state; failed turns stop here")}

    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-post"><span>Phase 4 — Post-turn Persistence and Proactive Loop</span><span class="pipeline-tag">after normal reply</span></div>
        ${renderPipelineStep({
          n: 15,
          title: "Success-only State Writeback",
          desc: "On success, the turn updates timestamps, visible history, scene_state, proactive candidates, and append-only chat history.",
          observe: "History tab, _visibleHistory, _sceneState, _proactiveIntents",
          control: "Read-only here; inspect and audit in History",
          source: "recordChatHistory()",
          type: "post",
          body: renderPipelineMeta(["user and assistant events are both recorded", "scenelet and next_scene_state are attached to assistant history events"]),
        })}
        ${renderPipelineStep({
          n: 16,
          title: "Memory Writer",
          desc: "After a successful turn, updateUserMemoryFromTurn() asks a separate writer to add/update/noop durable memory.",
          observe: "Memory tab and memory writer logs",
          control: "Memory writer prompt and soft maintenance limits",
          source: "buildMemoryWriterPrompt()",
          type: "post",
          body: `
            ${renderTextPreview("memoryWriterInstructions", p.memoryWriterInstructions)}
            ${renderControlGrid([
              renderNumberControl("memorySoftItemLimit", "Notice Item Limit", p.memorySoftItemLimit || 60, 10, 200, "items"),
              renderNumberControl("memorySoftPromptChars", "Notice Prompt Chars", p.memorySoftPromptChars || 1200, 200, 5000, "chars"),
            ])}
          `,
        })}
        ${renderPipelineStep({
          n: 17,
          title: "Proactive Candidate Queue",
          desc: "Scenelet candidates are normalized into one-shot pending intents; they can expire, be cancelled, or be sent.",
          observe: "Proactive tab pending/sent/cancelled intents",
          control: "Inspect and manage in Proactive tab",
          source: "_proactiveIntents",
          type: "post",
          body: renderPipelineMeta(["max 3 candidates per scenelet result", "candidate windows are ISO scheduled_at/expires_at values"]),
        })}
        ${renderPipelineStep({
          n: 18,
          title: "Proactive Evaluation",
          desc: "Periodic checker evaluates due pending intents with current observable state and may send a proactive visible_reply.",
          observe: "Proactive tab and proactive chat history events",
          control: "Evaluation prompt, check interval, cooldown",
          source: "buildProactivePrompt()",
          type: "post",
          body: `
            ${renderTextPreview("proactiveInstructions", p.proactiveInstructions)}
            ${renderControlGrid([
              renderNumberControl("proactiveCheckIntervalMs", "Check Interval", toS(p.proactiveCheckIntervalMs), 5, 300, "s", { ms: true }),
              renderNumberControl("proactiveCooldownMs", "Cooldown", toS(p.proactiveCooldownMs), 60, 86400, "s", { ms: true }),
            ])}
          `,
        })}
      </div>
    </div>

    ${renderPipelineArrow("Bot returns to polling and waits for the next inbound message")}
    <div id="promptsSaveBar" class="prompts-savebar" style="display:none">
      <span>有未保存的修改</span>
      <button class="btn btn-primary" id="promptsSaveBtn">Save All</button>
    </div>
  `;
}

function renderPipelineStep({ n, title, desc, observe, control, source, type, body = "", wide = false }) {
  return `
    <div class="pipeline-row${wide ? " pipeline-row-wide" : ""}">
      <div class="pipeline-left">
        <div class="pipeline-field">
          <div class="pipeline-field-head">
            <span class="pipeline-step-num">${String(n).padStart(2, "0")}</span>
            <span class="pipeline-field-label">${escHtml(title)}</span>
            <span class="pipeline-field-desc">${escHtml(desc)}</span>
          </div>
          <div class="pipeline-stage-meta">
            <span class="pipeline-chip observe">Observe: ${escHtml(observe)}</span>
            <span class="pipeline-chip control">Control: ${escHtml(control)}</span>
          </div>
          ${body}
        </div>
      </div>
      <div class="pipeline-connector"><span>─</span></div>
      <div class="pipeline-right">
        <div class="pipeline-node pipeline-node-${type}">
          <span class="pipeline-node-label">${escHtml(title)}</span>
          <span class="pipeline-node-src">${escHtml(source)}</span>
        </div>
      </div>
    </div>
  `;
}

function renderPipelineMeta(items = []) {
  return `<div class="pipeline-meta-list">${items.map(item => `<span>${escHtml(item)}</span>`).join("")}</div>`;
}

function renderControlGrid(items = []) {
  return `<div class="pipeline-control-grid">${items.join("")}</div>`;
}

function renderNumberControl(key, label, value, min, max, unit, options = {}) {
  const attrs = [
    `id="prompt_${key}"`,
    `class="prompts-editable prompts-num"`,
    `type="number"`,
    `min="${escAttr(min)}"`,
    `max="${escAttr(max)}"`,
    options.step ? `step="${escAttr(options.step)}"` : "",
    `value="${escAttr(value ?? "")}"`,
    `data-key="${escAttr(key)}"`,
    options.ms ? `data-ms="1"` : "",
  ].filter(Boolean).join(" ");
  return `
    <label class="pipeline-control">
      <span>${escHtml(label)}</span>
      <div class="pipeline-num-group"><input ${attrs}><span class="pipeline-num-unit">${escHtml(unit)}</span></div>
    </label>
  `;
}

function renderTextPreview(key, value) {
  const isOpen = promptsEditing[key];
  const draft = Object.prototype.hasOwnProperty.call(promptDrafts, key) ? promptDrafts[key] : value;
  if (isOpen) {
    const h = key === 'sceneletInstructions' || key === 'proactiveInstructions' || key === 'memoryWriterInstructions' ? '220px' : '110px';
    return `<textarea id="prompt_${key}" class="prompts-editable prompts-textarea" data-key="${key}" style="min-height:${h}">${escHtml(draft || '')}</textarea>
      <div class="editor-actions" style="margin-top:4px">
        <button class="btn btn-primary" data-action="save-text" data-key="${key}">Save</button>
        <button class="btn" data-action="cancel-text" data-key="${key}">Cancel</button>
      </div>`;
  }
  const preview = draft || '(empty)';
  return `<div class="pipeline-preview"><span class="pipeline-preview-text">${escHtml(preview)}</span><button class="btn" data-action="edit-text" data-key="${key}" style="min-height:26px;padding:2px 10px;font-size:11px;flex-shrink:0">Edit</button></div>`;
}

const RAG_KW_GROUPS = [
  { key: "lore", label: "Lore" },
  { key: "names", label: "Names" },
];

function renderRagKeywordChips(p) {
  if (!window._ragKwActiveGroup) window._ragKwActiveGroup = "lore";
  const activeGroup = window._ragKwActiveGroup;
  const keywords = getRagKw(activeGroup);
  const editingIdx = window._ragKwEditingIdx;

  const tabs = RAG_KW_GROUPS.map(g => {
    const count = getRagKw(g.key).length;
    return `<button class="rag-kw-tab${g.key === activeGroup ? ' active' : ''}" data-kwgroup="${g.key}">${escHtml(g.label)}<span class="rag-kw-tab-count">${count}</span></button>`;
  }).join("");

  const chips = keywords.map((word, i) => {
    if (editingIdx === i) {
      return `<span class="rag-kw-chip editing"><input class="rag-kw-chip-input" value="${escAttr(word)}" data-kwidx="${i}" data-action="kw-save-inline" placeholder="enter to save"><button class="rag-kw-chip-ok" data-action="kw-save-inline" data-kwidx="${i}" title="Save">OK</button></span>`;
    }
    return `<span class="rag-kw-chip">
      ${escHtml(word)}
      <button class="rag-kw-chip-del" data-action="kw-delete" data-kwidx="${i}" title="Delete">&times;</button>
      <button class="rag-kw-chip-edit" data-action="kw-edit" data-kwidx="${i}" title="Edit">&#9998;</button>
    </span>`;
  }).join("");

  const addRow = `<div class="rag-kw-add-row">
    <input class="rag-kw-add-input" placeholder="Add keyword and press Enter..." data-action="kw-add">
  </div>`;

  return `<div class="rag-kw-section">
    <label class="pipeline-sub-label">Trigger Keywords</label>
    <div class="rag-kw-tabs">${tabs}</div>
    <div class="rag-kw-chips">${chips || '<span class="rag-kw-empty">(no keywords)</span>'}</div>
    ${addRow}
  </div>`;
}

function renderPipelineText(key, label, desc, value, flowLabel, flowSrc, type) {
  const id = `prompt_${key}`;
  const isOpen = promptsEditing[key];
  const preview = (value || "").slice(0, 120);
  const hasMore = (value || "").length > 120;
  if (isOpen) {
    return `
      <div class="pipeline-row">
        <div class="pipeline-left">
          <div class="pipeline-field">
            <div class="pipeline-field-head">
              <span class="pipeline-field-label">${escHtml(label)}</span>
              <span class="pipeline-field-desc">${escHtml(desc)}</span>
            </div>
            <textarea id="${id}" class="prompts-editable prompts-textarea" data-key="${key}" style="min-height:130px">${escHtml(value || "")}</textarea>
            <div class="editor-actions" style="margin-top:6px">
              <button class="btn btn-primary" data-action="save-text" data-key="${key}">Save</button>
              <button class="btn" data-action="cancel-text" data-key="${key}">Cancel</button>
            </div>
          </div>
        </div>
        <div class="pipeline-connector"><span>─</span></div>
        <div class="pipeline-right">
          <div class="pipeline-node pipeline-node-${type}">
            <span class="pipeline-node-label">${escHtml(flowLabel)}</span>
            <span class="pipeline-node-src">${escHtml(flowSrc)}</span>
          </div>
        </div>
      </div>
    `;
  }
  return `
    <div class="pipeline-row">
      <div class="pipeline-left">
        <div class="pipeline-field">
          <div class="pipeline-field-head">
            <span class="pipeline-field-label">${escHtml(label)}</span>
            <span class="pipeline-field-desc">${escHtml(desc)}</span>
          </div>
          <div class="pipeline-preview">
            <span class="pipeline-preview-text">${escHtml(preview)}${hasMore ? '…' : ''}</span>
            <button class="btn" data-action="edit-text" data-key="${key}" style="min-height:28px;padding:3px 12px;font-size:12px;flex-shrink:0">Edit</button>
          </div>
        </div>
      </div>
      <div class="pipeline-connector"><span>─</span></div>
      <div class="pipeline-right">
        <div class="pipeline-node pipeline-node-${type}">
          <span class="pipeline-node-label">${escHtml(flowLabel)}</span>
          <span class="pipeline-node-src">${escHtml(flowSrc)}</span>
        </div>
      </div>
    </div>
  `;
}

function renderPipelineArrow(text) {
  return `
    <div class="pipeline-arrow-row">
      <span class="pipeline-arrow-down">▼</span>
      <span class="pipeline-arrow-text">${escHtml(text)}</span>
      <span class="pipeline-arrow-down">▼</span>
    </div>
  `;
}

async function savePrompts() {
  const updates = {};
  content.querySelectorAll('.prompts-editable').forEach(el => {
    const key = el.dataset.key;
    if (!key) return;
    let val;
    if (el.type === 'number') {
      val = Number(el.value);
      if (el.dataset.ms === '1') val = fromS(val);
    } else {
      val = el.value;
    }
    updates[key] = val;
  });
  for (const [key, value] of Object.entries(promptDrafts)) {
    updates[key] = value;
  }
  // RAG keyword edits — send the full ragKeywords object
  if (window._ragKwEdits && Object.keys(window._ragKwEdits).length) {
    updates.ragKeywords = JSON.parse(JSON.stringify(window._ragKwEdits));
    window._ragKwEdits = {};
  }
  const r = await api("PUT", "/api/prompts", updates);
  if (r.ok) {
    promptDrafts = {};
    toast("Saved — text changes take effect next turn; numeric params are live.");
    const bar = content.querySelector("#promptsSaveBar");
    if (bar) bar.style.display = "none";
  } else {
    toast(r.error, false);
  }
}

window.editProfile = async (name) => {
  const d = await get("/api/profiles");
  const p = d.profiles.find(x => x.name === name);
  if (!p) return;
  document.getElementById("profileForm").innerHTML = `
    <div class="profile-editor">
    <div class="editor-head">
      <h3>Edit: ${escHtml(name)}</h3>
      <span>${p.prompt.length.toLocaleString()} chars</span>
    </div>
    <div class="form-group"><label>Prompt</label><textarea id="editPrompt" class="profile-prompt-editor" spellcheck="false">${escHtml(p.prompt)}</textarea></div>
    <div class="editor-actions"><button class="btn btn-primary" id="saveProfileBtn">Save</button></div>
    </div>
  `;
  document.getElementById("saveProfileBtn").addEventListener("click", () => saveProfile(name));
  document.getElementById("editPrompt").focus();
};

window.saveProfile = async (name) => {
  const prompt = document.getElementById("editPrompt").value;
  const r = await api("PUT", "/api/profiles", { name, prompt });
  toast(r.ok ? "Saved" : r.error, r.ok);
  if (r.ok) render();
};

window.showAddProfile = () => {
  document.getElementById("profileForm").innerHTML = `
    <div class="profile-editor">
    <div class="editor-head"><h3>New Profile</h3></div>
    <div class="form-grid one"><div class="form-group"><label>Name</label><input id="newName"></div></div>
    <div class="form-group"><label>Prompt</label><textarea id="newPrompt" class="profile-prompt-editor" spellcheck="false"></textarea></div>
    <div class="editor-actions"><button class="btn btn-primary" onclick="addProfile()">Add</button></div>
    </div>
  `;
  document.getElementById("newName").focus();
};

window.addProfile = async () => {
  const name = document.getElementById("newName").value.trim();
  const prompt = document.getElementById("newPrompt").value.trim();
  if (!name || !prompt) { toast("Name and prompt required", false); return; }
  const r = await post("/api/profiles", { name, prompt });
  toast(r.ok ? "Added" : r.error, r.ok);
  if (r.ok) render();
};

window.deleteProfile = async (name) => {
  if (!confirm(`Delete profile "${name}"?`)) return;
  const r = await del("/api/profiles", { name });
  toast(r.ok ? `Deleted (${r.reverted} sessions reverted)` : r.error, r.ok);
  if (r.ok) render();
};

// History
let historyState = { q: "", sessionKey: "", page: 1, dateFrom: "", dateTo: "" };
const HISTORY_PAGE_SIZE = 20;

async function renderHistory() {
  const q = historyState.q || "";
  const dateFrom = historyState.dateFrom || "";
  const dateTo = historyState.dateTo || "";
  const dfParam = dateFrom ? `&dateFrom=${encodeURIComponent(dateFrom)}` : "";
  const dtParam = dateTo ? `&dateTo=${encodeURIComponent(dateTo)}` : "";
  const conv = await get(`/api/history/conversations?q=${encodeURIComponent(q)}${dfParam}${dtParam}`);
  const conversations = conv.conversations || [];
  if (!historyState.sessionKey && conversations.length) historyState.sessionKey = conversations[0].key;
  if (historyState.sessionKey && !conversations.some(x => x.key === historyState.sessionKey) && conversations.length) {
    historyState.sessionKey = conversations[0].key;
  }

  const page = historyState.page || 1;
  const skParam = historyState.sessionKey ? `&sessionKey=${encodeURIComponent(historyState.sessionKey)}` : "";
  const qParam = q ? `&q=${encodeURIComponent(q)}` : "";
  const msgPath = `/api/history/messages?page=${page}&pageSize=${HISTORY_PAGE_SIZE}${skParam}${qParam}${dfParam}${dtParam}`;
  const msg = historyState.sessionKey ? await get(msgPath) : { messages: [], total: 0, page: 1, totalPages: 1 };

  content.innerHTML = `
    <div class="panel history-panel">
      <div class="panel-head">
        <h2>Chat History</h2>
        <div class="history-toolbar">
          <span class="history-search-group">
            <input id="historySearch" class="history-search" placeholder="Search messages or scenelets" value="${escAttr(q)}">
            <button id="historySearchBtn" class="history-search-btn" title="Search">Search</button>
          </span>
          <span class="history-date-group">
            <input id="historyDateFrom" class="history-date" type="date" value="${escAttr(dateFrom)}" title="From date">
            <span class="history-date-sep">-</span>
            <input id="historyDateTo" class="history-date" type="date" value="${escAttr(dateTo)}" title="To date">
          </span>
        </div>
      </div>
      <div class="history-layout">
        <aside class="history-conversations">
          ${renderHistoryConversations(conversations)}
        </aside>
        <section class="history-messages">
          ${renderPagination(msg.total || 0, msg.page || 1, msg.totalPages || 1)}
          ${renderHistoryMessages(msg.messages || [])}
          ${renderPagination(msg.total || 0, msg.page || 1, msg.totalPages || 1)}
        </section>
      </div>
    </div>
  `;

  bindHistoryEvents();
}

function bindHistoryEvents() {
  const doSearch = () => {
    const input = content.querySelector("#historySearch");
    historyState.q = (input?.value || "").trim();
    historyState.sessionKey = "";
    historyState.page = 1;
    renderHistory();
  };
  content.querySelector("#historySearch")?.addEventListener("keydown", e => {
    if (e.key === "Enter") { doSearch(); }
  });
  content.querySelector("#historySearchBtn")?.addEventListener("click", () => { doSearch(); });
  content.querySelector("#historyDateFrom")?.addEventListener("change", e => {
    historyState.dateFrom = e.target.value;
    historyState.page = 1;
    renderHistory();
  });
  content.querySelector("#historyDateTo")?.addEventListener("change", e => {
    historyState.dateTo = e.target.value;
    historyState.page = 1;
    renderHistory();
  });
  content.querySelectorAll("[data-history-session]").forEach(btn => {
    btn.addEventListener("click", () => {
      historyState.sessionKey = btn.dataset.historySession;
      historyState.page = 1;
      renderHistory();
    });
  });
  content.querySelectorAll("[data-history-page]").forEach(btn => {
    btn.addEventListener("click", () => {
      historyState.page = Number(btn.dataset.historyPage) || 1;
      renderHistory();
    });
  });
  content.querySelector("#historyPageJumpInput")?.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      const totalPages = Number(e.target.dataset.totalPages) || 1;
      const page = Math.max(1, Math.min(totalPages, parseInt(e.target.value, 10) || 1));
      historyState.page = page;
      renderHistory();
    }
  });
  content.querySelector("#historyPageJumpBtn")?.addEventListener("click", () => {
    const input = content.querySelector("#historyPageJumpInput");
    if (!input) return;
    const totalPages = Number(input.dataset.totalPages) || 1;
    const page = Math.max(1, Math.min(totalPages, parseInt(input.value, 10) || 1));
    historyState.page = page;
    renderHistory();
  });
}

function renderPagination(total, page, totalPages) {
  if (totalPages <= 1) return "";
  const pages = [];
  const maxButtons = 7;
  let start = Math.max(1, page - 3);
  let end = Math.min(totalPages, start + maxButtons - 1);
  if (end - start < maxButtons - 1) start = Math.max(1, end - maxButtons + 1);

  if (page > 1) pages.push(`<button class="page-btn" data-history-page="${page - 1}" title="Previous">Prev</button>`);
  if (start > 1) {
    pages.push(`<button class="page-btn" data-history-page="1">1</button>`);
    if (start > 2) pages.push(`<span class="page-ellipsis">...</span>`);
  }
  for (let i = start; i <= end; i++) {
    pages.push(`<button class="page-btn${i === page ? " active" : ""}" data-history-page="${i}">${i}</button>`);
  }
  if (end < totalPages) {
    if (end < totalPages - 1) pages.push(`<span class="page-ellipsis">...</span>`);
    pages.push(`<button class="page-btn" data-history-page="${totalPages}">${totalPages}</button>`);
  }
  if (page < totalPages) pages.push(`<button class="page-btn" data-history-page="${page + 1}" title="Next">Next</button>`);
  pages.push(`<span class="page-jump"><input id="historyPageJumpInput" type="number" min="1" max="${totalPages}" value="${page}" data-total-pages="${totalPages}" title="Jump to page"><button id="historyPageJumpBtn" class="page-btn" title="Go">Go</button></span>`);

  return `<div class="pagination"><span class="page-info">${total} messages</span><div class="page-btns">${pages.join("")}</div></div>`;
}

function renderHistoryConversations(conversations) {
  if (!conversations.length) return '<p class="empty-text">No conversations yet</p>';
  return conversations.map(item => `
    <button class="history-conv ${item.key === historyState.sessionKey ? "active" : ""}" data-history-session="${escAttr(item.key)}">
      <span class="history-conv-top">
        <strong>${escHtml(item.sessionName || "Session")}</strong>
        <span class="badge badge-${item.ai === "cc" ? "cc" : "codex"}">${item.ai === "cc" ? "CC" : "Codex"}</span>
      </span>
      <span class="history-conv-meta">${escHtml(item.profile || "default")} · ${Number(item.count || 0)} msgs · ${Number(item.sceneletCount || 0)} scenelets</span>
      <span class="history-conv-last">${escHtml(item.lastText || "")}</span>
      <time>${formatTime(item.lastTimestamp)}</time>
    </button>
  `).join("");
}

function renderHistoryMessages(messages) {
  if (!messages.length) return '<p class="empty-text">No messages in this conversation</p>';
  return messages.map(item => `
    <article class="history-message ${item.role === "assistant" ? "assistant" : "user"}">
      <header>
        <span>${item.role === "assistant" ? escHtml(item.profile || "Assistant") : "User"}</span>
        <time>${formatTime(item.timestamp)}</time>
        ${item.kind && item.kind !== "chat" ? `<span class="history-kind">${escHtml(item.kind)}</span>` : ""}
      </header>
      <div class="history-text">${escHtml(item.text || "")}</div>
      ${item.scenelet ? `<details class="scenelet-details"><summary>inner scenelet</summary><pre>${escHtml(item.scenelet)}</pre></details>` : ""}
    </article>
  `).join("");
}

function formatTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return escHtml(value);
  return d.toLocaleString("zh-CN", { hour12: false });
}

function relativeTime(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function statusLabel(status) {
  return { pending: "Pending", sent: "Sent", cancelled: "Done" }[status] || status;
}

// Proactive
async function renderProactive() {
  const d = await get("/api/proactive/intents");
  const sessions = d.sessions || [];
  const now = Date.now();

  const allIntents = sessions.flatMap(s => s.intents.map(i => ({ ...i, sessionName: s.sessionName, profile: s.profile, ai: s.ai, active: s.active, busy: s.busy })));
  const pendingCount = allIntents.filter(i => i.status === "pending").length;
  const sentCount = allIntents.filter(i => i.status === "sent").length;
  const cancelledCount = allIntents.filter(i => i.status === "cancelled").length;

  content.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h2>Proactive Intents</h2></div>
      <div class="proactive-summary">
        <div class="proactive-summary-item sessions"><span class="label">Sessions</span><span class="value">${sessions.length}</span></div>
        <div class="proactive-summary-item pending"><span class="label">Pending</span><span class="value">${pendingCount}</span></div>
        <div class="proactive-summary-item sent"><span class="label">Sent</span><span class="value">${sentCount}</span></div>
        <div class="proactive-summary-item cancelled"><span class="label">Done</span><span class="value">${cancelledCount}</span></div>
      </div>
      ${sessions.length ? sessions.map(s => renderProactiveSession(s, now)).join("") : '<div class="proactive-empty">No proactive intents yet. Intents are created when the scenelet engine detects opportunities for proactive replies.</div>'}
    </div>
  `;

  // bind expand/collapse for scenelets
  content.querySelectorAll(".proactive-intent-scenelet").forEach(el => {
    el.addEventListener("toggle", () => {});
  });
}

function renderProactiveSession(session, now) {
  const intents = session.intents;
  const pending = intents.filter(i => i.status === "pending").reverse();
  const sent = intents.filter(i => i.status === "sent").reverse();
  const cancelled = intents.filter(i => i.status === "cancelled").reverse();

  // Detect merges: cancelled intents whose cancelReason references another intent
  const mergedByTargetId = new Map();
  const standalone = [];
  for (const i of cancelled) {
    const target = findMergeTarget(i, intents);
    if (target) {
      if (!mergedByTargetId.has(target.id)) mergedByTargetId.set(target.id, []);
      mergedByTargetId.get(target.id).push(i);
    } else {
      standalone.push(i);
    }
  }
  const mergedTargetIds = new Set(mergedByTargetId.keys());

  // Build sent group items (including merged targets that are sent)
  const sentItems = [];
  for (const i of sent) {
    if (mergedTargetIds.has(i.id)) {
      sentItems.push(renderProactiveIntentWithMerged(i, now, mergedByTargetId.get(i.id)));
    } else {
      sentItems.push(renderProactiveIntent(i, now, 0));
    }
  }
  // Pending items that are merge targets
  const pendingItems = [];
  for (const i of pending) {
    if (mergedTargetIds.has(i.id)) {
      pendingItems.push(renderProactiveIntentWithMerged(i, now, mergedByTargetId.get(i.id)));
    } else {
      pendingItems.push(renderProactiveIntent(i, now, 0));
    }
  }

  const sentVisible = sent.length;
  const doneVisible = cancelled.length;

  const total = pending.length + sent.length + cancelled.length;
  return `
    <div class="proactive-session-card">
      <div class="proactive-session-head">
        <div class="session-info">
          <span class="badge badge-${session.ai === 'cc' ? 'cc' : 'codex'}">${session.ai === 'cc' ? 'CC' : 'Codex'}</span>
          <strong>${escHtml(session.sessionName)}</strong>
          <span class="badge badge-default">${escHtml(session.profile)}</span>
          ${session.active ? '<span class="resume-current">Active</span>' : ''}
        </div>
        <span style="font-size:12px;color:var(--muted)">${total} intent${total !== 1 ? 's' : ''}</span>
      </div>
      <div class="proactive-intent-list">
        ${pendingItems.length
          ? pendingItems.join("")
          : '<div class="proactive-group-empty">No pending intents</div>'}
        ${sentVisible ? renderCollapsibleGroup("sent", sentVisible, sentItems) : ""}
        ${doneVisible ? renderCollapsibleGroup("done", doneVisible, standalone.map(i => renderProactiveIntent(i, now, 0))) : ""}
      </div>
    </div>
  `;
}

function findMergeTarget(intent, allIntents) {
  if (!intent.cancelReason) return null;
  for (const other of allIntents) {
    if (other.id === intent.id) continue;
    if (intent.cancelReason.includes(other.id)) return other;
  }
  if (/merge|合并|并入|重复/.test(intent.cancelReason)) {
    const similar = allIntents.find(o =>
      o.id !== intent.id && o.status !== "cancelled" &&
      o.messageIntent && intent.messageIntent &&
      charOverlap(o.messageIntent, intent.messageIntent) > 0.5
    );
    if (similar) return similar;
  }
  return null;
}

function charOverlap(a, b) {
  const sa = new Set(a.replace(/\s+/g, ""));
  const sb = new Set(b.replace(/\s+/g, ""));
  const intersection = [...sa].filter(x => sb.has(x)).length;
  return intersection / (Math.max(sa.size, sb.size) || 1);
}

function renderProactiveIntentWithMerged(target, now, mergedIntents) {
  const main = renderProactiveIntent(target, now, mergedIntents.length);
  const mergedBlocks = mergedIntents.map(m => `
    <div class="proactive-intent-merged-note">
      <span class="proactive-intent-dot cancelled" style="margin-top:0"></span>
      <span style="font-size:11px;color:var(--muted)">
        Merged: ${escHtml((m.messageIntent || m.cancelReason || "(similar)").slice(0, 100))}
        ${m.cancelledAt ? " &mdash; " + formatTime(m.cancelledAt) : ""}
      </span>
    </div>
  `).join("");

  const idx = main.lastIndexOf("</div>");
  return main.slice(0, idx) + mergedBlocks + main.slice(idx);
}

function renderCollapsibleGroup(groupClass, count, itemsHtml) {
  if (count === 0) return "";
  const label = groupClass === "sent" ? "Sent" : "Done";
  return `
    <details class="proactive-group">
      <summary class="proactive-group-summary">
        <span class="proactive-group-dot ${groupClass}"></span>
        <span class="proactive-group-label">${label}</span>
        <span class="proactive-group-count">${count}</span>
      </summary>
      <div class="proactive-group-body">
        ${Array.isArray(itemsHtml) ? itemsHtml.join("") : itemsHtml}
      </div>
    </details>
  `;
}

function renderProactiveIntent(intent, now, mergedCount = 0) {
  const scheduledMs = Date.parse(intent.scheduledAt) || 0;
  const expiresMs = intent.expiresAt ? (Date.parse(intent.expiresAt) || 0) : 0;
  const isOverdue = intent.status === "pending" && scheduledMs < now;
  const isExpired = intent.status === "pending" && expiresMs > 0 && expiresMs < now;
  const relLabel = intent.status === "pending"
    ? (isOverdue ? "overdue" : (scheduledMs > now ? "in " + relativeTime(intent.scheduledAt) : "now"))
    : (intent.status === "sent" ? "sent " + relativeTime(intent.sentAt || intent.scheduledAt) + " ago" : "");

  return `
    <div class="proactive-intent-item">
      <span class="proactive-intent-dot ${intent.status}${isOverdue || isExpired ? ' cancelled' : ''}" title="${statusLabel(intent.status)}${isOverdue ? ' (overdue)' : ''}${isExpired ? ' (expired)' : ''}"></span>
      <div class="proactive-intent-body">
        <div class="proactive-intent-top">
          <span class="proactive-intent-status ${intent.status}">${statusLabel(intent.status)}${isOverdue ? ' (overdue)' : ''}${isExpired ? ' (expired)' : ''}${mergedCount ? ' +' + mergedCount + ' merged' : ''}</span>
          <span style="font-size:12px;color:var(--muted)">${relLabel}</span>
        </div>
        <div class="proactive-intent-intent">${escHtml(intent.messageIntent || "(no intent text)")}</div>
        <div class="proactive-intent-meta">
          <span>Scheduled: <time>${formatTime(intent.scheduledAt)}</time></span>
          ${intent.expiresAt ? `<span>Expires: <time>${formatTime(intent.expiresAt)}</time></span>` : ""}
          ${intent.sentAt ? `<span>Sent: <time>${formatTime(intent.sentAt)}</time></span>` : ""}
          ${intent.cancelledAt ? `<span>Cancelled: <time>${formatTime(intent.cancelledAt)}</time></span>` : ""}
        </div>
        ${intent.basis ? `<div class="proactive-intent-basis">${escHtml(intent.basis)}</div>` : ""}
        ${intent.cancelReason ? `<div class="proactive-intent-basis" style="background:rgba(194,65,61,0.05);color:var(--danger)">Cancel: ${escHtml(intent.cancelReason)}</div>` : ""}
        ${intent.cancelIf?.length ? `<div class="proactive-intent-cancel-if">${intent.cancelIf.map(c => `<span>${escHtml(c)}</span>`).join("")}</div>` : ""}
        ${intent.innerScenelet ? `<details class="proactive-intent-scenelet"><summary>inner scenelet</summary><pre>${escHtml(intent.innerScenelet)}</pre></details>` : ""}
        ${intent.sourceUserText ? `<div style="margin-top:4px;font-size:11px;color:var(--muted)">Source: ${escHtml(intent.sourceUserText.slice(0, 120))}${intent.sourceUserText.length > 120 ? '...' : ''}</div>` : ""}
      </div>
    </div>
  `;
}

// Memory
let memoryState = { role: "", category: "", editingId: null, renameUid: null, allEntries: [], allUsers: [] };

const CAT_LABELS = { trait: "Trait", preference: "Preference", fact: "Fact" };
const CAT_ORDER = ["trait", "preference", "fact"];

function currentUserId() {
  return memoryState.allUsers[0]?.userId || "";
}

function currentDisplayName() {
  const u = memoryState.allUsers[0];
  return (u?.displayName) || (u?.userId) || "";
}

function userDisplayName(uid) {
  const u = memoryState.allUsers.find(u => u.userId === uid);
  return (u?.displayName) || uid;
}

async function renderMemory() {
  const d = await get("/api/memory");
  const entries = d.entries || [];
  const users = d.users || [];
  memoryState.allEntries = entries;
  memoryState.allUsers = users;

  const uid = currentUserId();
  const selUser = users.find(u => u.userId === uid);
  const roles = selUser ? selUser.roles : [];
  if (!roles.includes(memoryState.role) && roles.length) {
    memoryState.role = roles[0];
  }

  const filtered = filterMemoryEntries();
  const counts = { trait: 0, preference: 0, fact: 0 };
  for (const e of filtered) { if (counts[e.category] !== undefined) counts[e.category]++; }

  const dName = currentDisplayName();
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Memory — ${escHtml(dName)}</h2>
        <button class="btn btn-primary" id="memoryAddBtn">+ Add Memory</button>
      </div>
      ${renderMemorySummary(filtered.length, counts)}
      ${renderMemoryToolbar(roles)}
      ${renderMemoryFilterChips(counts)}
      ${renderMemoryCards(filtered)}
    </div>
    <div id="memoryEditorMount"></div>
  `;

  bindMemoryEvents();
}

function filterMemoryEntries() {
  let items = memoryState.allEntries;
  const uid = currentUserId();
  if (uid) items = items.filter(e => e.userId === uid);
  if (memoryState.role) items = items.filter(e => e.role === memoryState.role);
  if (memoryState.category) items = items.filter(e => e.category === memoryState.category);
  items.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return items;
}

function renderMemorySummary(total, counts) {
  return `
    <div class="memory-summary">
      <div class="memory-summary-item total"><span class="label">Total</span><span class="value">${total}</span></div>
      <div class="memory-summary-item trait"><span class="label">Trait</span><span class="value">${counts.trait}</span></div>
      <div class="memory-summary-item preference"><span class="label">Preference</span><span class="value">${counts.preference}</span></div>
      <div class="memory-summary-item fact"><span class="label">Fact</span><span class="value">${counts.fact}</span></div>
    </div>
  `;
}

function renderMemoryToolbar(roles) {
  const userId = currentUserId();
  const dName = currentDisplayName();
  const isRenaming = memoryState.renameUid === userId;
  return `
    <div class="memory-toolbar">
      <div class="form-group" style="margin-bottom:0;min-width:160px">
        <label>User</label>
        ${isRenaming
          ? `<span class="rename-row"><input id="renameInput" class="rename-input" value="${escAttr(dName)}" placeholder="Display name"><button class="btn btn-primary" data-action="save-rename" style="min-height:28px;padding:2px 12px;font-size:11px">Save</button><button class="btn" data-action="cancel-rename" style="min-height:28px;padding:2px 12px;font-size:11px">Cancel</button></span>`
          : `<span class="memory-user-inline"><span class="user-display-name">${escHtml(dName)}</span>${dName !== userId ? `<span class="user-raw-id">(${escHtml(userId)})</span>` : ""}<button class="btn rename-user-btn" data-action="rename-user" title="Rename" style="margin-left:6px">✎</button></span>`}
      </div>
      <div class="form-group" style="margin-bottom:0;min-width:160px">
        <label>Role</label>
        <select id="memoryRoleSelect">${roles.map(r => `<option value="${escAttr(r)}"${r === memoryState.role ? " selected" : ""}>${escHtml(r)}</option>`).join("") || '<option value="">--</option>'}</select>
      </div>
    </div>
  `;
}

function renderMemoryFilterChips(counts) {
  const cat = memoryState.category;
  const total = (counts.trait || 0) + (counts.preference || 0) + (counts.fact || 0);
  let chips = `<button class="memory-filter-chip${cat === "" ? " active" : ""}" data-cat="">All<span class="chip-count">${total}</span></button>`;
  for (const c of CAT_ORDER) {
    chips += `<button class="memory-filter-chip${cat === c ? " active" : ""}" data-cat="${c}">${CAT_LABELS[c]}<span class="chip-count">${counts[c] || 0}</span></button>`;
  }
  return `<div class="memory-filter-chips">${chips}</div>`;
}

function renderMemoryCards(entries) {
  if (!entries.length) return '<div class="memory-empty">No memory entries found. Click "+ Add Memory" to create one.</div>';

  // Group by role only (single user)
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.role)) groups.set(e.role, []);
    groups.get(e.role).push(e);
  }

  let html = "";
  for (const [role, items] of groups) {
    html += `<div class="memory-role-section">
      <div class="memory-user-head">
        <span class="memory-role-badge">${escHtml(role)}</span>
        <span style="color:var(--muted);font-size:11px">${items.length} entries</span>
      </div>
      <div class="memory-section-cards">`;
    for (const item of items) {
      html += renderMemoryCard(item);
    }
    html += `</div></div>`;
  }
  return html;
}

function renderMemoryCard(item) {
  const isEditing = memoryState.editingId === item.id;
  if (isEditing) return renderMemoryCardEdit(item);

  return `
    <div class="memory-card" data-mem-id="${escAttr(item.id)}">
      <div class="memory-card-top">
        <span class="memory-card-category ${item.category}">${CAT_LABELS[item.category] || item.category}</span>
        <div class="memory-card-actions">
          <button class="btn" data-action="edit-memory" data-id="${escAttr(item.id)}">Edit</button>
          <button class="btn btn-danger" data-action="delete-memory" data-id="${escAttr(item.id)}">Del</button>
        </div>
      </div>
      <div class="memory-card-text">${escHtml(item.text)}</div>
      <div class="memory-card-meta">
        <div class="memory-card-tags">
          ${item.sensitive ? '<span class="memory-tag sensitive">Sensitive</span>' : ''}
          <span class="memory-tag source">${escHtml(item.source || "manual")}</span>
        </div>
        <span class="meta-sep">·</span>
        <span>Updated ${formatTime(item.updatedAt)}</span>
      </div>
    </div>
  `;
}

function renderMemoryCardEdit(item) {
  return `
    <div class="memory-card" data-mem-id="${escAttr(item.id)}" style="border-color:var(--primary);box-shadow:0 0 0 3px rgba(31,111,235,0.14);">
      <div class="form-group" style="margin-bottom:8px">
        <label>Category</label>
        <select id="editCat_${escAttr(item.id)}">
          ${CAT_ORDER.map(c => `<option value="${c}"${item.category === c ? " selected" : ""}>${CAT_LABELS[c]}</option>`).join("")}
        </select>
      </div>
      <div class="form-group" style="margin-bottom:8px">
        <label>Text</label>
        <textarea id="editText_${escAttr(item.id)}" style="min-height:70px">${escHtml(item.text)}</textarea>
      </div>
      <div class="form-group" style="margin-bottom:10px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:650">
          <input type="checkbox" id="editSensitive_${escAttr(item.id)}"${item.sensitive ? " checked" : ""}> Sensitive
        </label>
      </div>
      <div class="editor-actions">
        <button class="btn btn-primary" data-action="save-memory" data-id="${escAttr(item.id)}">Save</button>
        <button class="btn" data-action="cancel-edit">Cancel</button>
      </div>
    </div>
  `;
}

function bindMemoryEvents() {
  content.querySelector("#memoryAddBtn")?.addEventListener("click", showMemoryEditor);

  content.querySelector("#memoryRoleSelect")?.addEventListener("change", e => {
    memoryState.role = e.target.value;
    memoryState.editingId = null;
    memoryState.renameUid = null;
    renderMemory();
  });

  content.querySelectorAll(".memory-filter-chip").forEach(btn => {
    btn.addEventListener("click", () => {
      memoryState.category = btn.dataset.cat;
      memoryState.editingId = null;
      memoryState.renameUid = null;
      renderMemory();
    });
  });

  content.querySelectorAll('[data-action="edit-memory"]').forEach(btn => {
    btn.addEventListener("click", () => {
      memoryState.editingId = btn.dataset.id;
      memoryState.renameUid = null;
      renderMemory();
    });
  });

  content.querySelectorAll('[data-action="cancel-edit"]').forEach(btn => {
    btn.addEventListener("click", () => {
      memoryState.editingId = null;
      renderMemory();
    });
  });

  content.querySelectorAll('[data-action="save-memory"]').forEach(btn => {
    btn.addEventListener("click", () => saveMemoryEdit(btn.dataset.id));
  });

  content.querySelectorAll('[data-action="delete-memory"]').forEach(btn => {
    btn.addEventListener("click", () => deleteMemoryItem(btn.dataset.id));
  });

  content.querySelectorAll('[data-action="rename-user"]').forEach(btn => {
    btn.addEventListener("click", () => {
      memoryState.renameUid = currentUserId();
      memoryState.editingId = null;
      renderMemory();
      setTimeout(() => {
        const inp = content.querySelector("#renameInput");
        if (inp) { inp.focus(); inp.select(); }
      }, 60);
    });
  });

  content.querySelectorAll('[data-action="save-rename"]').forEach(btn => {
    btn.addEventListener("click", () => saveRename());
  });

  content.querySelectorAll('[data-action="cancel-rename"]').forEach(btn => {
    btn.addEventListener("click", () => { memoryState.renameUid = null; renderMemory(); });
  });

  const renameInp = content.querySelector("#renameInput");
  if (renameInp) {
    renameInp.addEventListener("keydown", e => {
      if (e.key === "Enter") saveRename();
    });
  }
}

async function saveRename() {
  const uid = currentUserId();
  const inp = content.querySelector("#renameInput");
  if (!inp || !uid) return;
  const displayName = inp.value.trim();
  const r = await api("PUT", "/api/memory/user", { userId: uid, displayName });
  if (r.ok) {
    toast(displayName ? `Renamed to "${displayName}"` : "Display name cleared");
    memoryState.renameUid = null;
    renderMemory();
  } else {
    toast(r.error, false);
  }
}

function showMemoryEditor() {
  const mount = content.querySelector("#memoryEditorMount");
  if (!mount) return;
  mount.innerHTML = `
    <div class="memory-editor-overlay" id="memoryOverlay">
      <div class="memory-editor">
        <h3>New Memory Entry</h3>
        <div class="form-group">
          <label>Role</label>
          <input id="memNewRole" value="${escAttr(memoryState.role)}" placeholder="e.g. 白鹭千圣">
        </div>
        <div class="form-group">
          <label>Category</label>
          <select id="memNewCat">
            ${CAT_ORDER.map(c => `<option value="${c}">${CAT_LABELS[c]}</option>`).join("")}
          </select>
        </div>
        <div class="form-group">
          <label>Text</label>
          <textarea id="memNewText" placeholder="Memory content (max 180 chars)" style="min-height:80px"></textarea>
        </div>
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:650">
            <input type="checkbox" id="memNewSensitive"> Sensitive
          </label>
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" id="memNewSave">Add</button>
          <button class="btn" id="memNewCancel">Cancel</button>
        </div>
      </div>
    </div>
  `;

  mount.querySelector("#memNewSave").addEventListener("click", async () => {
    const userId = currentUserId();
    const role = mount.querySelector("#memNewRole").value.trim();
    const category = mount.querySelector("#memNewCat").value;
    const text = mount.querySelector("#memNewText").value.trim();
    const sensitive = mount.querySelector("#memNewSensitive").checked;
    if (!userId || !role || !text) { toast("Role and Text are required", false); return; }
    const r = await post("/api/memory", { userId, role, category, text, sensitive });
    if (r.ok) {
      toast(r.updated ? "Updated existing entry" : "Added");
      memoryState.role = role;
      memoryState.editingId = null;
      mount.innerHTML = "";
      renderMemory();
    } else {
      toast(r.error, false);
    }
  });

  mount.querySelector("#memNewCancel").addEventListener("click", () => { mount.innerHTML = ""; });
  mount.querySelector("#memoryOverlay")?.addEventListener("click", e => {
    if (e.target === e.currentTarget) mount.innerHTML = "";
  });

  setTimeout(() => mount.querySelector("#memNewUserId")?.focus(), 60);
}

async function saveMemoryEdit(id) {
  const cat = content.querySelector(`#editCat_${id}`)?.value;
  const text = content.querySelector(`#editText_${id}`)?.value?.trim();
  const sensitive = content.querySelector(`#editSensitive_${id}`)?.checked;
  if (!text) { toast("Text is required", false); return; }
  const item = memoryState.allEntries.find(e => e.id === id);
  if (!item) { toast("Item not found", false); return; }
  const r = await api("PUT", "/api/memory", { id, category: cat, text, sensitive, userId: item.userId, role: item.role });
  if (r.ok) {
    toast("Saved");
    memoryState.editingId = null;
    renderMemory();
  } else {
    toast(r.error, false);
  }
}

async function deleteMemoryItem(id) {
  const item = memoryState.allEntries.find(e => e.id === id);
  if (!item) return;
  const dName = userDisplayName(item.userId);
  if (!confirm(`Delete memory entry?\n\n"${item.text.slice(0, 80)}"\n\nUser: ${dName} / Role: ${item.role}`)) return;
  const r = await del("/api/memory", { id, userId: item.userId, role: item.role });
  if (r.ok) {
    toast("Deleted");
    renderMemory();
  } else {
    toast(r.error, false);
  }
}

// Config
function F(key, label, value, type, placeholder = "") {
  return `<div class="form-group"><label>${label}</label><input name="${key}" value="${escHtml(String(value ?? ''))}" type="${type || 'text'}" placeholder="${escAttr(placeholder)}"></div>`;
}
function Select(key, label, value, options) {
  const selected = String(value ?? "");
  const opts = options.map(([val, text]) => `<option value="${escAttr(val)}"${selected === val ? " selected" : ""}>${escHtml(text)}</option>`).join("");
  return `<div class="form-group"><label>${label}</label><select name="${key}">${opts}</select></div>`;
}
function S(title, body) { return `<h3>${title}</h3>${body}`; }

async function renderConfig() {
  const d = await get("/api/config");
  const c = d.config || {};

  const formHtml = [
    S("Paths", F("paths.npmGlobal", "NPM Global Directory", c.paths?.npmGlobal, "text", "Auto") + F("paths.claude", "Claude Code Path", c.paths?.claude, "text", "Auto") + F("paths.codex", "Codex Path", c.paths?.codex, "text", "Auto") + F("paths.ragScript", "RAG Script Path", c.paths?.ragScript, "text", "Auto") + F("paths.workDir", "AI Working Directory", c.paths?.workDir, "text", "Auto")),
    S("Proxy", F("proxy.https", "Shared HTTPS Proxy", c.proxy?.https, "text", "Fallback") + F("proxy.claudeHttps", "Claude HTTPS Proxy", c.proxy?.claudeHttps, "text", "Direct when empty") + F("proxy.codexHttps", "Codex HTTPS Proxy", c.proxy?.codexHttps, "text", "http://127.0.0.1:7892") + F("proxy.ragHttps", "RAG HTTPS Proxy", c.proxy?.ragHttps, "text", "Fallback")),
    S("Models", F("models.claudeFast", "Claude Fast Model", c.models?.claudeFast) + F("models.claudeFallback", "Claude Fallback Model", c.models?.claudeFallback) + F("models.scenelet", "Scenelet Model", c.models?.scenelet)),
    S("Timeouts", F("timeouts.aiMs", "AI Timeout (ms)", c.timeouts?.aiMs, "number")),
    S("Vision", Select("vision.mode", "Mode", c.vision?.mode || "auto", [["auto", "Auto"], ["external", "External API"], ["native", "Native backend"], ["off", "Off"]]) + F("vision.baseUrl", "API Base URL", c.vision?.baseUrl, "text", "Default SiliconFlow") + F("vision.apiKey", "API Key", c.vision?.apiKey, "password", "Only for External API") + F("vision.model", "Model Name", c.vision?.model, "text", "Default Qwen/Qwen3-VL-32B-Instruct") + F("vision.detail", "Detail Level", c.vision?.detail) + F("vision.timeoutMs", "Timeout (ms)", c.vision?.timeoutMs, "number")),
    S("RAG", F("rag.knowledgeDir", "Knowledge Directory", c.rag?.knowledgeDir) + F("rag.collectionName", "Collection Name", c.rag?.collectionName) + F("rag.embedModel", "Embedding Model", c.rag?.embedModel) + F("rag.storeDir", "Vector Store Dir", c.rag?.storeDir) + F("rag.modelCacheDir", "Model Cache Dir", c.rag?.modelCacheDir) + F("rag.scoreMargin", "Score Margin", c.rag?.scoreMargin, "number") + F("rag.chunkMaxChars", "Chunk Max Chars", c.rag?.chunkMaxChars, "number") + F("rag.batchSize", "Batch Size", c.rag?.batchSize, "number") + F("rag.enabled", "Enabled (true/false)", c.rag?.enabled)),
    S("Logs", F("logs.retentionDays", "Retention (days, 0=never)", c.logs?.retentionDays, "number")),
  ].join("");

  content.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h2>Configuration</h2></div>
      <form id="configForm" class="config-form">${formHtml}<button type="submit" class="btn btn-primary mt">Save</button></form>
    </div>
  `;

  document.getElementById("configForm").addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const obj = buildNested(fd);
    const r = await post("/api/config", obj);
    toast(r.ok ? "Saved. Restart bot to apply runtime settings." : r.error, r.ok);
  });
}

function buildNested(fd) {
  const obj = {};
  for (const [key, val] of fd.entries()) {
    const parts = key.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = cur[parts[i]] || {};
      cur = cur[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (val === "true") cur[last] = true;
    else if (val === "false") cur[last] = false;
    else if (["aiMs", "timeoutMs", "topK", "minScore", "scoreMargin", "chunkMaxChars", "resultMaxChars", "batchSize", "retentionDays"].includes(last)) cur[last] = Number(val);
    else cur[last] = val;
  }
  return obj;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escAttr(s) { return escHtml(s); }

// RAG keyword helpers — read/write pending edits stored in _ragKwEdits
function getRagKw(groupKey) {
  if (!window._ragKwEdits) window._ragKwEdits = {};
  const val = window._ragKwEdits[groupKey];
  if (typeof val === "string") return val.split("|").filter(Boolean);
  if (typeof val === "number") return [String(val)];
  return [];
}
function setRagKw(groupKey, arr) {
  if (!window._ragKwEdits) window._ragKwEdits = {};
  window._ragKwEdits[groupKey] = arr.join("|");
}

setInterval(() => { document.getElementById("clock").textContent = new Date().toLocaleString("zh-CN"); }, 1000);
render();
