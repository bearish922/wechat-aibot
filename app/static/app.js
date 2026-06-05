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
      case "world": await renderWorld(); break;
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
          <div class="resume-command-stack">
            <code class="resume-command">${escHtml(item.command)}</code>
            ${item.hiddenWorldSid ? `<code class="resume-command">hidden-world: claude --resume ${escHtml(item.hiddenWorldSid)}${item.hiddenWorldFirstTurn ? " (first turn)" : ""}</code>` : '<code class="resume-command">hidden-world: not started</code>'}
          </div>
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
      <td>${Number(pr.bindings)} 个会话</td>
      <td class="actions-cell">
        <button class="btn" data-action="edit-profile" data-profile="${escAttr(pr.name)}">编辑</button>
        ${pr.name !== '默认' ? `<button class="btn btn-danger" data-action="delete-profile" data-profile="${escAttr(pr.name)}">删除</button>` : ''}
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

let promptsEditing = {};
let promptDrafts = {};

function renderPromptsPipeline(p, profileRows) {
  const profileTable = `
    <div class="pipeline-embedded-table">
      <div class="table-wrap"><table>
        <thead><tr><th>名称</th><th>Prompt 预览</th><th>绑定会话</th><th></th></tr></thead>
        <tbody>${profileRows || '<tr><td colspan="4">暂无 profiles</td></tr>'}</tbody>
      </table></div>
      <div class="pipeline-table-actions">
        <button class="btn btn-primary" onclick="showAddProfile()">+ 新增 Profile</button>
        <div id="profileForm"></div>
      </div>
    </div>`;

  return `
    <div class="panel">
      <div class="panel-head">
        <h2>运行时 Prompt Pipeline</h2>
        <span class="status-pill online">实时配置</span>
      </div>
      <div class="pipeline-summary">
        <span>按真实执行顺序展示：从微信入站消息，到模型回复后的本地状态写回。</span>
        <span>可编辑控件会写入 <code>data/prompts.json</code>、profile 模板，或引导你到 Memory / History 等对应观察面。</span>
      </div>
    </div>

    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-input"><span>阶段 0 — 入站消息、会话、附件</span><span class="pipeline-tag">processTurn() 之前</span></div>
        ${renderPipelineStep({
          n: 1,
          title: "WeChat 入站轮询",
          desc: "iLink 收到新消息后，消息进入当前会话队列，再由 sessionLoop() 调用 processTurn()。",
          source: "getUpdates → sessionLoop",
          type: "input",
          body: renderPipelineMeta(["本环节只读", "失败/测试轮次不会进入已完成的可见上下文", "新消息可以取消过期的 proactive intent"]),
        })}
        ${renderPipelineStep({
          n: 2,
          title: "会话 Profile 绑定",
          desc: "当前会话绑定的 profile 会决定使用哪个角色模板，以及是否启用角色聊天专属上下文层。",
          source: "wechat-profiles.json",
          type: "sys",
          wide: true,
          body: profileTable,
        })}
        ${renderPipelineStep({
          n: 3,
          title: "入站附件 / Vision Caption",
          desc: "如果用户发送图片，Vision 会先生成图片描述；带附件的轮次不会触发 RAG 检索。",
          source: "visionCaptionPrompt",
          type: "input",
          body: renderTextPreview("visionCaptionPrompt", p.visionCaptionPrompt),
        })}
        ${renderPipelineStep({
          n: 4,
          title: "失败轮次保护",
          desc: "只有成功完成的轮次才会推进会话状态；失败轮次单独保留为重试上下文，不写入普通聊天历史。",
          source: "_lastFailedTurn",
          type: "input",
          body: renderPipelineMeta(["本环节只读", "只有成功后才会更新 visible history、scene_state、proactive candidates 和 memory writer"]),
        })}
      </div>
    </div>

    ${renderPipelineArrow("processTurn() 开始：读取 profile、style prompt、memory prompt，并创建本轮日志")}

    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-sys"><span>阶段 1 — 稳定 System Context</span><span class="pipeline-tag">system prompt file / Codex prompt prefix</span></div>
        ${renderPipelineStep({
          n: 5,
          title: "Profile Template",
          desc: "当当前会话不是默认 profile 时，角色模板会作为稳定角色底座注入；角色基本事实和核心关系应集中维护在 profile 中。",
          source: "wechat-profiles.json",
          type: "sys",
          body: renderPipelineMeta(["Profile 模板在上方表格编辑", "固定规则文件已不再作为 GUI 流程层展示", "默认 profile 会跳过角色聊天专属上下文层"]),
        })}
        ${renderPipelineStep({
          n: 6,
          title: "稳定表达能力",
          desc: "buildStableStylePrompt() 只把表情和表达能力规则加入稳定 system 层；聊天写法会在主模型轮次里靠近用户消息注入。",
          source: "reply.mjs / prompts.json",
          type: "sys",
          body: `
            <label class="pipeline-sub-label">表达能力</label>
            ${renderTextPreview("expressionCapability", p.expressionCapability)}
          `,
        })}
      </div>
    </div>

    ${renderPipelineArrow("稳定 system context 到这里结束；接下来组装主回复动态 turn body")}

    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-body"><span>阶段 2 — 主回复动态 Turn Body</span><span class="pipeline-tag">stdin body prefix</span></div>
        ${renderPipelineStep({
          n: 7,
          title: "长期记忆注入",
          desc: "主回复路径会把当前 userId + profile 下的完整 memory snapshot 放在 turn body 最前面；不再进入稳定 system prompt。",
          source: "wechat-memory.json",
          type: "body",
          body: `
            ${renderTextPreview("memoryContextInstruction", p.memoryContextInstruction)}
            ${renderPipelineMeta(["memoryDefaultLimit 默认值是 6；当前只作为带 query 相关召回的 fallback，主回复路径没有使用", "memory snapshot 变化只影响本轮动态 body，不再打断稳定 system prompt cache"])}
          `,
        })}
        ${renderPipelineStep({
          n: 8,
          title: "Hidden-world 输出注入",
          desc: "主回复不读取可见上下文窗口；它依赖自己的 Claude/Codex session 历史，再接收本轮 hidden-world 直接传入的 scene_state、life_arc 简述、inner_scenelet 和 bridge instruction。",
          source: "buildSceneContextBlock()",
          type: "body",
          body: renderPipelineMeta(["这些内容由 Hidden World 页配置和观察", "主回复页不编辑 hidden-world 生成提示词", "life_arc 只传简述，不传完整 active life_arcs JSON"]),
        })}
        ${renderPipelineStep({
          n: 9,
          title: "RAG Eligibility Gate",
          desc: "只有在 RAG 已启用、消息无附件、profile 非默认、没有被 casual-skip 跳过，并且命中显式 profile / names / lore 条件时，才会检索。",
          source: "shouldUseRagForTurn()",
          type: "body",
          body: `
            ${renderPipelineMeta(["shouldSkipRag() 的寒暄跳过规则：本页只读", "显式提到其他 profile 名称：自动触发", "无效 keyword regex 会记录日志并跳过"])}
            ${renderRagKeywordChips(p)}
            <label class="pipeline-sub-label">RAG 上下文说明</label>
            ${renderTextPreview("ragContextInstruction", p.ragContextInstruction)}
            ${renderControlGrid([
              renderNumberControl("ragTopK", "Top-K", p.ragTopK || 6, 1, 20, "docs"),
              renderNumberControl("ragMinScore", "最低分数", p.ragMinScore || 0.48, 0, 1, "score", { step: "0.01" }),
              renderNumberControl("ragResultMaxChars", "最大字符数", p.ragResultMaxChars || 3600, 500, 10000, "chars"),
              renderNumberControl("ragTimeoutMs", "超时", toS(p.ragTimeoutMs), 5, 120, "s", { ms: true }),
            ])}
          `,
        })}
        ${renderPipelineStep({
          n: 10,
          title: "聊天写法 / 聊天现实 + 用户消息",
          desc: "buildTurnBody() 在用户消息前加入聊天写法和当前聊天现实，明确用户侧北京时间与角色侧东京时间，再把带北京时间标记的用户原始消息放到最后。",
          source: "buildTurnBody()",
          type: "model",
          body: `
            <label class="pipeline-sub-label">聊天写法</label>
            ${renderTextPreview("chatStyle", p.chatStyle)}
            <label class="pipeline-sub-label">聊天现实规则 / 时间戳描述</label>
            ${renderTextPreview("chatRealityInstructions", p.chatRealityInstructions)}
          `,
        })}
      </div>
    </div>

    ${renderPipelineArrow("Turn Body 按真实顺序组装：memory snapshot → scene_state + inner_scenelet → RAG context → 聊天写法/聊天现实规则 → 带时间戳的用户消息")}

    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-model"><span>阶段 3 — 主模型轮次</span><span class="pipeline-tag">Claude stream-json / Codex json</span></div>
        ${renderPipelineStep({
          n: 11,
          title: "后端 Prompt 组装",
          desc: "Claude 只把 profile 和稳定表达能力写入 --append-system-prompt-file；memory snapshot、scene_state、inner_scenelet 和 RAG 从 stdin body 进入，不属于稳定 system prompt。",
          source: "runClaudeStream() / runCodexStream()",
          type: "model",
          body: renderPipelineMeta(["本环节只读；由上游控件共同决定", "主回复不直接读取完整 active life_arcs", "Claude 在 stdin body 中接收 memory、scene_state、inner_scenelet 和 RAG", "Codex 在组合 prompt 前接收 RAG；memory 仍随 turn body 注入", "Claude profile 聊天默认走可 resume 的缓存路径；Codex profile 聊天仍使用 no-session-persistence"]),
        })}
        ${renderPipelineStep({
          n: 12,
          title: "流式输出、切分、发送",
          desc: "assistant 文本先进入缓冲区；遇到工具调用或长输出会中途 flush，最终角色聊天会被切成更自然的微信消息。",
          source: "flush() → splitSocialReply() → sendMessage()",
          type: "post",
          body: renderPipelineMeta(["本环节只读", "splitText() 强制执行 MAX_REPLY_LEN", "成功的角色聊天最终片段会附加 /"]),
        })}
      </div>
    </div>

    ${renderPipelineArrow("只有成功轮次会推进本地持久状态；失败轮次在这里停止")}

    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-post"><span>阶段 4 — 回复后持久化</span><span class="pipeline-tag">普通回复完成后</span></div>
        ${renderPipelineStep({
          n: 13,
          title: "成功后状态写回",
          desc: "轮次成功后，系统会更新时间戳、可见历史、scene_state、proactive candidates，以及追加式聊天历史。",
          source: "recordChatHistory()",
          type: "post",
          body: renderPipelineMeta(["本环节只读；在 History 页检查和审计", "user 和 assistant 事件都会记录", "scenelet、next_scene_state 和 life_arc_ops 会随成功轮次写入本地状态"]),
        })}
        ${renderPipelineStep({
          n: 14,
          title: "Memory Writer",
          desc: "成功轮次之后，updateUserMemoryFromTurn() 先抽取长期记忆候选，再用完整 memory items 做 add / update / noop 合并规划。",
          source: "memory_candidate_extractor / memory_merge_planner",
          type: "post",
          body: `
            ${renderTextPreview("memoryWriterInstructions", p.memoryWriterInstructions)}
            ${renderControlGrid([
              renderNumberControl("memorySoftItemLimit", "提醒条目数", p.memorySoftItemLimit || 60, 10, 200, "items"),
              renderNumberControl("memorySoftPromptChars", "提醒字符数", p.memorySoftPromptChars || 1200, 200, 5000, "chars"),
            ])}
            ${renderPipelineMeta(["候选抽取使用 fast model", "合并规划读取带 id 的正式 memory items", "两个重要环节都会写入 hidden usage 日志"])}
          `,
        })}
        ${renderPipelineStep({
          n: 15,
          title: "Hidden-world 后续工序",
          desc: "proactive candidate queue、daily share seed、schedule finalization 和 proactive evaluation 都在 Hidden World 页配置；主回复页只保留这一条总览。",
          source: "Hidden World Pipeline",
          type: "post",
          body: renderPipelineMeta(["候选生成与二次判断不在主回复 prompt 中调参", "History 页记录 RAG 是否触发", "Hidden World 页记录 hidden-world sid、usage/cache 和 reset 快照"]),
        })}
      </div>
    </div>

    ${renderPipelineArrow("Bot 回到轮询状态，等待下一条入站消息")}
    <div id="promptsSaveBar" class="prompts-savebar" style="display:none">
      <span>有未保存的修改</span>
      <button class="btn btn-primary" id="promptsSaveBtn">全部保存</button>
    </div>
  `;
}

function renderPipelineStep({ n, title, desc, source, type, body = "", wide = false }) {
  return `
    <div class="pipeline-row${wide ? " pipeline-row-wide" : ""}">
      <div class="pipeline-left">
        <div class="pipeline-field">
          <div class="pipeline-field-head">
            <span class="pipeline-field-label">${String(n).padStart(2, "0")} ${escHtml(title)}</span>
            <span class="pipeline-field-desc">${escHtml(desc)}</span>
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
    const h = key === 'sceneletInstructions' || key === 'lifeArcInstructions' || key === 'dailyShareSeedInstructions' || key === 'proactiveInstructions' || key === 'memoryWriterInstructions' || key === 'scheduleCreatorInstructions' ? '220px' : '110px';
    return `<textarea id="prompt_${key}" class="prompts-editable prompts-textarea" data-key="${key}" style="min-height:${h}">${escHtml(draft || '')}</textarea>
      <div class="editor-actions" style="margin-top:4px">
        <button class="btn btn-primary" data-action="save-text" data-key="${key}">保存</button>
        <button class="btn" data-action="cancel-text" data-key="${key}">取消</button>
      </div>`;
  }
  const preview = draft || '(empty)';
  return `<div class="pipeline-preview"><span class="pipeline-preview-text">${escHtml(preview)}</span><button class="btn" data-action="edit-text" data-key="${key}" style="min-height:26px;padding:2px 10px;font-size:11px;flex-shrink:0">编辑</button></div>`;
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
      return `<span class="rag-kw-chip editing"><input class="rag-kw-chip-input" value="${escAttr(word)}" data-kwidx="${i}" data-action="kw-save-inline" placeholder="回车保存"><button class="rag-kw-chip-ok" data-action="kw-save-inline" data-kwidx="${i}" title="保存">OK</button></span>`;
    }
    return `<span class="rag-kw-chip">
      ${escHtml(word)}
      <button class="rag-kw-chip-del" data-action="kw-delete" data-kwidx="${i}" title="删除">&times;</button>
      <button class="rag-kw-chip-edit" data-action="kw-edit" data-kwidx="${i}" title="编辑">&#9998;</button>
    </span>`;
  }).join("");

  const addRow = `<div class="rag-kw-add-row">
    <input class="rag-kw-add-input" placeholder="添加关键词后按回车..." data-action="kw-add">
  </div>`;

  return `<div class="rag-kw-section">
    <label class="pipeline-sub-label">触发关键词</label>
    <div class="rag-kw-tabs">${tabs}</div>
    <div class="rag-kw-chips">${chips || '<span class="rag-kw-empty">（暂无关键词）</span>'}</div>
    ${addRow}
  </div>`;
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
    toast("已保存：文本改动会在下一轮生效，数值参数实时生效。");
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
      <h3>编辑：${escHtml(name)}</h3>
      <span>${p.prompt.length.toLocaleString()} chars</span>
    </div>
    <div class="form-group"><label>Prompt</label><textarea id="editPrompt" class="profile-prompt-editor" spellcheck="false">${escHtml(p.prompt)}</textarea></div>
    <div class="editor-actions"><button class="btn btn-primary" id="saveProfileBtn">保存</button></div>
    </div>
  `;
  document.getElementById("saveProfileBtn").addEventListener("click", () => saveProfile(name));
  document.getElementById("editPrompt").focus();
};

window.saveProfile = async (name) => {
  const prompt = document.getElementById("editPrompt").value;
  const r = await api("PUT", "/api/profiles", { name, prompt });
  toast(r.ok ? "已保存" : r.error, r.ok);
  if (r.ok) render();
};

window.showAddProfile = () => {
  document.getElementById("profileForm").innerHTML = `
    <div class="profile-editor">
    <div class="editor-head"><h3>新增 Profile</h3></div>
    <div class="form-grid one"><div class="form-group"><label>名称</label><input id="newName"></div></div>
    <div class="form-group"><label>Prompt</label><textarea id="newPrompt" class="profile-prompt-editor" spellcheck="false"></textarea></div>
    <div class="editor-actions"><button class="btn btn-primary" onclick="addProfile()">新增</button></div>
    </div>
  `;
  document.getElementById("newName").focus();
};

window.addProfile = async () => {
  const name = document.getElementById("newName").value.trim();
  const prompt = document.getElementById("newPrompt").value.trim();
  if (!name || !prompt) { toast("名称和 prompt 不能为空", false); return; }
  const r = await post("/api/profiles", { name, prompt });
  toast(r.ok ? "已新增" : r.error, r.ok);
  if (r.ok) render();
};

window.deleteProfile = async (name) => {
  if (!confirm(`删除 profile "${name}"？`)) return;
  const r = await del("/api/profiles", { name });
  toast(r.ok ? `已删除（${r.reverted} 个会话已回退）` : r.error, r.ok);
  if (r.ok) render();
};

// Hidden World
let worldState = { profile: "", resetProfile: "" };

async function renderWorld() {
  const [wd, pd] = await Promise.all([get("/api/world/roles"), get("/api/prompts")]);
  const profiles = wd.profiles || [];
  if (!worldState.profile && profiles.length) worldState.profile = profiles.includes("白鹭千圣") ? "白鹭千圣" : profiles[0];
  const role = (wd.roles || []).find(r => r.profile === worldState.profile) || wd.roles?.[0] || {};
  const p = pd.prompts || {};
  if (worldState.resetProfile) {
    renderWorldReset(role, p);
    return;
  }

  content.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Hidden World Pipeline</h2>
        <span class="history-toolbar">
          <select id="worldProfileSelect" class="history-date">${profiles.map(name => `<option value="${escAttr(name)}"${name === role.profile ? " selected" : ""}>${escHtml(name)}</option>`).join("")}</select>
          <button class="btn" data-action="open-world-reset">Reset / Edit Snapshot</button>
        </span>
      </div>
      <div class="pipeline-summary">
        <span>Hidden world 以 profile 为单位持久化；多个微信线程共享同一个角色世界线和 hidden-world sid。</span>
        <span>本页只调整 hidden-world 的提示词、判断器和状态参数；主回复写法留在 Prompts 页。</span>
      </div>
    </div>

    ${renderWorldPipeline(role, p)}

    <div id="promptsSaveBar" class="prompts-savebar" style="display:none">
      <span>有未保存的 hidden-world prompt 修改</span>
      <button class="btn btn-primary" id="promptsSaveBtn">全部保存</button>
    </div>
  `;
  bindWorldEvents();
  bindPromptEditorEvents(renderWorld);
}

function renderWorldPipeline(role, p) {
  const world = role.worldSession || {};
  const usage = world.lastUsage || {};
  return `
    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-sys"><span>阶段 1 — Hidden World System Prompt</span><span class="pipeline-tag">role-level claude session</span></div>
        ${renderPipelineStep({
          n: 1,
          title: "Role Profile + Chat Style",
          desc: "hidden-world 读取 profile template、固定角色信息和聊天写法参考，用于构建稳定隐藏世界；不使用主回复的 buildStableStylePrompt()。",
          source: "profileTemplates / getChatStyle()",
          type: "sys",
          body: `
            ${renderPipelineMeta(["profile template 只在 Profiles 表里维护", "chatStyle 可编辑，但最终微信回复仍在主回复页靠近用户消息注入", "hidden-world 的目标是世界连续性，不承担最终措辞"])}
            ${renderTextPreview("chatStyle", p.chatStyle)}
          `,
        })}
        ${renderPipelineStep({
          n: 2,
          title: "Scenelet + Life Arc Instructions",
          desc: "这些提示词定义 hidden-world 每轮要生成的 scene_state、life_arcs、inner_scenelet 和世界线更新规则。",
          source: "sceneletInstructions / lifeArcInstructions",
          type: "sys",
          body: `
            ${renderTextPreview("sceneletInstructions", p.sceneletInstructions)}
            ${renderTextPreview("lifeArcInstructions", p.lifeArcInstructions)}
            ${renderTextPreview("sceneStateIntro", p.sceneStateIntro)}
            ${renderTextPreview("innerSceneletIntro", p.innerSceneletIntro)}
            ${renderTextPreview("sceneletReplyBridgeInstruction", p.sceneletReplyBridgeInstruction)}
          `,
        })}
      </div>
    </div>

    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-body"><span>阶段 2 — Dynamic Context</span><span class="pipeline-tag">each user turn</span></div>
        ${renderPipelineStep({
          n: 3,
          title: "当前 role-level session",
          desc: "hidden-world 首轮使用 --session-id；之后使用 --resume。这里的 sid 是角色级，不随微信线程变化。",
          source: "_worldSession",
          type: "body",
          body: renderWorldSessionSnapshot(role, usage),
        })}
        ${renderPipelineStep({
          n: 4,
          title: "Memory + Recent Visible Chat",
          desc: "hidden-world 当前沿用旧 scenelet 层输入：读取 memoryPrompt 和最近可见聊天窗口；主回复不读取这个可见窗口，只依赖自身 session 历史。",
          source: "renderMemoryPrompt() / recentVisibleContext()",
          type: "body",
          body: `
            ${renderTextPreview("memoryContextInstruction", p.memoryContextInstruction)}
            ${renderTextPreview("chatHistoryIntro", p.chatHistoryIntro)}
            ${renderControlGrid([
              renderNumberControl("visibleContextTurns", "可见轮次数", p.visibleContextTurns || 8, 1, 30, "turns"),
            ])}
            ${renderPipelineMeta(["Memory 是否应该继续进 hidden-world：当前保留，原因是 scenelet 需要知道用户长期偏好和关系事实", "RAG context 当前不进 hidden-world；旧 scenelet 层也不接收 RAG，只允许 WebSearch/WebFetch guard 控制需要时搜索"])}
          `,
        })}
        ${renderPipelineStep({
          n: 5,
          title: "Time Reality + Search Guard",
          desc: "hidden-world 每轮拿到双时区当前时间、微信聊天现实、当前用户消息和 Web/Search guard。时间字段由代码生成，提示词可通过聊天现实规则调整。",
          source: "currentTimeContext() / chatRealityInstructions / CURRENT_SITE_AND_SEARCH_GUARD",
          type: "body",
          body: `
            ${renderTextPreview("chatRealityInstructions", p.chatRealityInstructions)}
            ${renderPipelineMeta(["时间戳 JSON 本身只读，由 currentTimeContext() 生成", "Web/Search guard 当前是代码常量，只读", "RAG 检索上下文当前只传主回复，不传 hidden-world"])}
          `,
        })}
      </div>
    </div>

    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-model"><span>阶段 3 — Generated Hidden Outputs</span><span class="pipeline-tag">JSON contract</span></div>
        ${renderPipelineStep({
          n: 6,
          title: "Scene State / Life Arcs / Inner Scenelet",
          desc: "hidden-world 输出最新 scene_state、完整 active life_arcs JSON 和 inner_scenelet；主回复只接收 scene_state、life_arc 简述、inner_scenelet 和 bridge instruction。",
          source: "inner_scenelet / next_scene_state / life_arc_ops",
          type: "model",
          body: renderPipelineMeta(["完整 life_arcs 留在 hidden-world 和本地快照", "主回复只拿简版，避免自行扩写日程", "last scene_state 不再作为 hidden-world 的依赖输入"]),
        })}
        ${renderPipelineStep({
          n: 7,
          title: "World State Patch",
          desc: "结构化记录当前地点、活动、清醒状态、近几小时计划和未闭合线索。该字段偏数据契约，正常只读。",
          source: "world_state_patch",
          type: "model",
          body: renderPipelineMeta(["字段：location / activity / awake_state / current_plan / open_threads / last_world_event_at", "具体内容在 reset 快照页编辑，不在正常 pipeline 中直接改"]),
        })}
        ${renderPipelineStep({
          n: 8,
          title: "Daily Share + Schedule Candidates",
          desc: "hidden-world 先生成 daily_share_candidates 和 schedule_candidates；后续二次判断决定是否真正进入 proactive queue 或 schedule life_arc。",
          source: "daily_share_candidates / schedule_candidates",
          type: "model",
          body: `
            ${renderTextPreview("dailyShareSeedInstructions", p.dailyShareSeedInstructions)}
            ${renderTextPreview("scheduleCreatorInstructions", p.scheduleCreatorInstructions)}
            ${renderTextPreview("scheduleSpecialDates", p.scheduleSpecialDates)}
            ${renderControlGrid([
              renderNumberControl("dailyShareSeedIntervalMs", "Seed 间隔", toS(p.dailyShareSeedIntervalMs), 60, 86400, "s", { ms: true }),
              renderNumberControl("dailyShareMinIdleMs", "自然空档", toS(p.dailyShareMinIdleMs), 60, 86400, "s", { ms: true }),
              renderNumberControl("scheduleCheckIntervalMs", "日程检查", toS(p.scheduleCheckIntervalMs), 600, 604800, "s", { ms: true }),
              renderNumberControl("scheduleMaxActive", "最大日程", p.scheduleMaxActive || 2, 1, 5, "items"),
            ])}
          `,
        })}
        ${renderPipelineStep({
          n: 9,
          title: "Time Reasoning + Continuity Warnings",
          desc: "hidden-world 每轮输出时间推理和连续性警告供日志审计；页面只保留相关约束说明，不展示每轮内容。",
          source: "time_reasoning / continuity_warnings",
          type: "model",
          body: renderPipelineMeta(["连续 10 分钟内多轮对话不能累计为多次被叫醒", "睡眠和日程时长必须能由当前时间算通", "用户纠正时间逻辑时优先修正 hidden-world 快照"]),
        })}
      </div>
    </div>

    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-post"><span>阶段 4 — Independent Finalizers</span><span class="pipeline-tag">after normal turn / idle checks</span></div>
        ${renderPipelineStep({
          n: 10,
          title: "Proactive / Daily / Schedule Finalization",
          desc: "回复完成后，程序把 hidden-world 的候选交给独立判断器：proactive evaluation、daily share seeding 和 schedule finalization。",
          source: "proactiveInstructions / schedule_finalization",
          type: "post",
          body: `
            ${renderTextPreview("proactiveInstructions", p.proactiveInstructions)}
            ${renderControlGrid([
              renderNumberControl("proactiveCheckIntervalMs", "检查间隔", toS(p.proactiveCheckIntervalMs), 5, 300, "s", { ms: true }),
              renderNumberControl("proactiveCooldownMs", "冷却时间", toS(p.proactiveCooldownMs), 60, 86400, "s", { ms: true }),
              renderNumberControl("proactiveDailyMax", "每日上限", p.proactiveDailyMax || 8, 1, 24, "msgs"),
            ])}
          `,
        })}
      </div>
    </div>
  `;
}

function renderWorldSessionSnapshot(role, usage) {
  const world = role.worldSession || {};
  const sessions = role.sessions || [];
  return `
    <div class="world-session-grid">
      ${renderWorldBox("Hidden World", [
        ["sid", world.sid || "(not started)"],
        ["resume", world.sid ? `claude --resume ${world.sid}` : "(not started)"],
        ["model", world.model || "(default scenelet model)"],
        ["firstTurn", String(Boolean(world.firstTurn))],
        ["lastUsedAt", world.lastUsedAt || ""],
      ])}
      ${renderWorldBox("Last Usage", [
        ["duration", usage?.duration_ms ? `${usage.duration_ms}ms` : ""],
        ["input", usage?.input_tokens ?? ""],
        ["cacheRead", usage?.cache_read_input_tokens ?? ""],
        ["cacheCreate", usage?.cache_creation_input_tokens ?? ""],
        ["output", usage?.output_tokens ?? ""],
      ])}
      ${renderWorldBox("Wechat Threads", [
        ["count", sessions.length],
        ["active", sessions.filter(s => s.active).length],
        ["pending", sessions.reduce((sum, s) => sum + Number(s.pendingIntents || 0), 0)],
      ])}
    </div>
    ${sessions.length ? `<div class="table-wrap"><table><thead><tr><th>AI</th><th>Thread</th><th>Main sid</th><th>Visible turns</th><th>Pending</th></tr></thead><tbody>${sessions.map(s => `
      <tr><td>${escHtml(s.ai)}</td><td>${escHtml(s.sessionName)}${s.active ? " · active" : ""}</td><td>${escHtml(s.sid || "")}</td><td>${Number(s.visibleTurns || 0)}</td><td>${Number(s.pendingIntents || 0)}</td></tr>
    `).join("")}</tbody></table></div>` : '<p class="empty-text">No bound WeChat threads for this profile</p>'}
  `;
}

function renderWorldBox(title, rows) {
  return `
    <div class="world-box">
      <h3>${escHtml(title)}</h3>
      ${rows.map(([k, v]) => `
        <div class="world-kv"><span>${escHtml(k)}</span><strong>${escHtml(String(v ?? ""))}</strong></div>
      `).join("")}
    </div>
  `;
}

function bindWorldEvents() {
  content.querySelector("#worldProfileSelect")?.addEventListener("change", e => {
    worldState.profile = e.target.value;
    renderWorld();
  });
  content.querySelector('[data-action="open-world-reset"]')?.addEventListener("click", () => {
    worldState.resetProfile = worldState.profile;
    renderWorld();
  });
}

function renderWorldReset(role) {
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Reset Hidden World — ${escHtml(role.profile || worldState.resetProfile)}</h2>
        <button class="btn" data-action="cancel-world-reset">Back</button>
      </div>
      <div class="pipeline-summary">
        <span>这里编辑的是权威快照。保存后会重置 hidden-world sid，下一轮用这些静态状态冷启动。</span>
      </div>
      <div class="form-grid one">
        ${renderSnapshotTextarea("worldState", "world_state", role.worldState)}
        ${renderSnapshotTextarea("sceneState", "scene_state", role.sceneState)}
        ${renderSnapshotTextarea("lifeArcs", "active life_arcs", role.lifeArcs || [])}
        ${renderSnapshotTextarea("threadIntents", "thread proactive intents", role.threadIntents || [])}
        ${renderSnapshotTextarea("lastOutput", "last hidden output", role.lastOutput)}
        <div class="form-grid">
          <div class="form-group"><label>lastDailyShareSeedAt</label><input id="snap_lastDailyShareSeedAt" value="${escAttr(role.lastDailyShareSeedAt || "")}"></div>
          <div class="form-group"><label>lastScheduleCheckAt</label><input id="snap_lastScheduleCheckAt" value="${escAttr(role.lastScheduleCheckAt || "")}"></div>
        </div>
      </div>
      <div class="editor-actions">
        <button class="btn btn-primary" data-action="save-world-reset">Save Snapshot and Reset Session</button>
        <button class="btn" data-action="cancel-world-reset">Cancel</button>
      </div>
    </div>
  `;
  content.querySelectorAll('[data-action="cancel-world-reset"]').forEach(btn => {
    btn.addEventListener("click", () => { worldState.resetProfile = ""; renderWorld(); });
  });
  content.querySelector('[data-action="save-world-reset"]')?.addEventListener("click", saveWorldReset);
}

function renderSnapshotTextarea(id, label, value) {
  return `<div class="form-group"><label>${escHtml(label)}</label><textarea id="snap_${id}" class="profile-prompt-editor" spellcheck="false" style="min-height:180px">${escHtml(JSON.stringify(value || null, null, 2))}</textarea></div>`;
}

async function saveWorldReset() {
  const profile = worldState.resetProfile || worldState.profile;
  const payload = {
    profile,
    worldState: JSON.parse(content.querySelector("#snap_worldState")?.value || "null"),
    sceneState: JSON.parse(content.querySelector("#snap_sceneState")?.value || "null"),
    lifeArcs: JSON.parse(content.querySelector("#snap_lifeArcs")?.value || "[]"),
    threadIntents: JSON.parse(content.querySelector("#snap_threadIntents")?.value || "[]"),
    lastOutput: JSON.parse(content.querySelector("#snap_lastOutput")?.value || "null"),
    lastDailyShareSeedAt: content.querySelector("#snap_lastDailyShareSeedAt")?.value || null,
    lastScheduleCheckAt: content.querySelector("#snap_lastScheduleCheckAt")?.value || null,
  };
  const r = await post("/api/world/reset", payload);
  toast(r.ok ? "Hidden world reset" : r.error, r.ok);
  if (r.ok) {
    worldState.resetProfile = "";
    renderWorld();
  }
}

function bindPromptEditorEvents(afterSave = render) {
  content.querySelectorAll('.prompts-editable').forEach(el => {
    el.addEventListener('input', () => {
      if (el.tagName === "TEXTAREA" && el.dataset.key) promptDrafts[el.dataset.key] = el.value;
      showSaveBar();
    });
    el.addEventListener('change', () => {
      if (el.tagName === "TEXTAREA" && el.dataset.key) promptDrafts[el.dataset.key] = el.value;
      showSaveBar();
    });
  });
  content.querySelectorAll('[data-action="edit-text"]').forEach(btn => {
    btn.addEventListener("click", () => { promptsEditing[btn.dataset.key] = true; afterSave(); });
  });
  content.querySelectorAll('[data-action="cancel-text"]').forEach(btn => {
    btn.addEventListener("click", () => {
      delete promptDrafts[btn.dataset.key];
      promptsEditing[btn.dataset.key] = false;
      afterSave();
    });
  });
  content.querySelectorAll('[data-action="save-text"]').forEach(btn => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.key;
      const el = content.querySelector(`#prompt_${key}`);
      if (el) promptDrafts[key] = el.value;
      promptsEditing[key] = false;
      await savePrompts();
      afterSave();
    });
  });
  content.querySelector("#promptsSaveBtn")?.addEventListener("click", async () => {
    await savePrompts();
    afterSave();
  });
}

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
      ${renderHistorySceneletNote(item)}
      ${renderHistoryToolNote(item)}
      ${item.scenelet ? `<details class="scenelet-details"><summary>inner scenelet</summary><pre>${escHtml(item.scenelet)}</pre></details>` : ""}
    </article>
  `).join("");
}

function renderHistorySceneletNote(item) {
  if (item.role !== "assistant") return "";
  if (item.scenelet) return "";
  if (item.sceneletStatus !== "missing") return "";
  const reason = item.sceneletError ? `: ${item.sceneletError}` : "";
  return `<div class="history-tool-note">Scenelet: missing${escHtml(reason)}</div>`;
}

function renderHistoryToolNote(item) {
  if (item.role !== "assistant") return "";
  const usage = item.toolUsage;
  const rag = item.ragUsage;
  const webLine = (() => {
    if (!usage) return "WebSearch: not recorded";
    const searched = Number(usage.webSearch || 0) > 0;
    const fetched = Number(usage.webFetch || 0) > 0;
    const detail = [
      searched ? `${Number(usage.webSearch)} search` : "",
      fetched ? `${Number(usage.webFetch)} fetch` : "",
    ].filter(Boolean).join(" · ");
    return `WebSearch: ${searched ? "yes" : "no"}${detail ? ` (${detail})` : ""}`;
  })();
  const ragLine = (() => {
    if (!rag) return "RAG: not recorded";
    const detail = rag.eligible ? (Number(rag.chars || 0) > 0 ? `${Number(rag.chars)} chars` : "eligible") : "not eligible";
    return `RAG: ${rag.used ? "yes" : "no"} (${detail})`;
  })();
  return `<div class="history-tool-note">${escHtml(webLine)}<br>${escHtml(ragLine)}</div>`;
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
let proactiveState = { profile: "" };

async function renderProactive() {
  const d = await get("/api/proactive/intents");
  const allSessions = d.sessions || [];
  const profiles = [...new Set(allSessions.map(s => s.profile || "default"))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  if (!proactiveState.profile && profiles.length) proactiveState.profile = profiles.includes("白鹭千圣") ? "白鹭千圣" : profiles[0];
  const sessions = proactiveState.profile ? allSessions.filter(s => (s.profile || "default") === proactiveState.profile) : allSessions;
  const now = Date.now();

  const allIntents = sessions.flatMap(s => (s.intents || []).map(i => ({ ...i, sessionName: s.sessionName, profile: s.profile, ai: s.ai, active: s.active, busy: s.busy })));
  const lifeArcCount = sessions.reduce((sum, s) => sum + (s.lifeArcs || []).length, 0);
  const pendingCount = allIntents.filter(i => i.status === "pending").length;
  const sentCount = allIntents.filter(i => i.status === "sent").length;
  const cancelledCount = allIntents.filter(i => i.status === "cancelled").length;

  content.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Proactive Intents</h2>
        <span class="history-toolbar">
          <select id="proactiveProfileSelect" class="history-date">
            ${profiles.map(name => `<option value="${escAttr(name)}"${name === proactiveState.profile ? " selected" : ""}>${escHtml(name)}</option>`).join("")}
          </select>
        </span>
      </div>
      <div class="proactive-summary">
        <div class="proactive-summary-item sessions"><span class="label">Sessions</span><span class="value">${sessions.length}</span></div>
        <div class="proactive-summary-item pending"><span class="label">Pending</span><span class="value">${pendingCount}</span></div>
        <div class="proactive-summary-item sent"><span class="label">Sent</span><span class="value">${sentCount}</span></div>
        <div class="proactive-summary-item cancelled"><span class="label">Done</span><span class="value">${cancelledCount}</span></div>
        <div class="proactive-summary-item life-arcs"><span class="label">Life Arcs</span><span class="value">${lifeArcCount}</span></div>
      </div>
      ${sessions.length ? sessions.map(s => renderProactiveSession(s, now)).join("") : '<div class="proactive-empty">No proactive intents or active life lines yet. They are created when the scenelet engine detects natural continuity.</div>'}
    </div>
  `;

  // bind expand/collapse for scenelets
  content.querySelectorAll(".proactive-intent-scenelet").forEach(el => {
    el.addEventListener("toggle", () => {});
  });
  content.querySelector("#proactiveProfileSelect")?.addEventListener("change", e => {
    proactiveState.profile = e.target.value;
    renderProactive();
  });
}

function renderProactiveSession(session, now) {
  const intents = session.intents || [];
  const lifeArcs = session.lifeArcs || [];
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
        <span style="font-size:12px;color:var(--muted)">${total} intent${total !== 1 ? 's' : ''} · ${lifeArcs.length} life line${lifeArcs.length !== 1 ? 's' : ''}</span>
      </div>
      ${lifeArcs.length ? renderLifeArcList(lifeArcs, now) : ""}
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

function renderLifeArcList(lifeArcs, now) {
  return `
    <div class="life-arc-list">
      ${lifeArcs.map(a => renderLifeArc(a, now)).join("")}
    </div>
  `;
}

function renderLifeArc(arc, now) {
  const expires = arc.expiresAt ? Date.parse(arc.expiresAt) : NaN;
  const isExpiring = Number.isFinite(expires) && expires - now < 6 * 60 * 60 * 1000;
  const kindLabels = { travel: "旅行", work: "工作/通告", school: "学校", personal: "个人", special_date: "特殊日" };
  const kindBadge = arc.kind ? `<span class="life-arc-kind life-arc-kind-${escHtml(arc.kind)}">${kindLabels[arc.kind] || arc.kind}</span>` : "";
  const timeRange = (arc.timeStart || arc.timeEnd) ? `
    <div class="life-arc-timerange">
      ${arc.timeStart ? `<span>开始: <time>${formatTime(arc.timeStart)}</time></span>` : ""}
      ${arc.timeEnd ? `<span>结束: <time>${formatTime(arc.timeEnd)}</time></span>` : ""}
    </div>` : "";
  return `
    <div class="life-arc-item ${isExpiring ? 'expiring' : ''}">
      <div class="life-arc-top">
        <strong>${kindBadge}${escHtml(arc.title || "(untitled life line)")}</strong>
        ${arc.expiresAt ? `<time>到期: ${formatTime(arc.expiresAt)}</time>` : ""}
      </div>
      ${timeRange}
      ${arc.currentState ? `<div class="life-arc-state">${escHtml(arc.currentState)}</div>` : ""}
      ${arc.summary ? `<div class="life-arc-summary">${escHtml(arc.summary)}</div>` : ""}
      ${arc.nextUsefulMoment ? `<div class="life-arc-next">${escHtml(arc.nextUsefulMoment)}</div>` : ""}
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
          <span class="proactive-intent-status ${intent.status}">${statusLabel(intent.status)}${isOverdue ? ' (overdue)' : ''}${isExpired ? ' (expired)' : ''}${mergedCount ? ' +' + mergedCount + ' merged' : ''}${intent.kind ? ' · ' + escHtml(intent.kind) : ''}</span>
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
