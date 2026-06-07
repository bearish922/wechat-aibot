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
function toH(ms) { return +((ms || 0) / 3600000).toFixed(1); }
function fromH(h) { return (h || 0) * 3600000; }
function toD(ms) { return +((ms || 0) / 86400000).toFixed(1); }
function fromD(d) { return (d || 0) * 86400000; }

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

async function savePromptField(key, value, silent = false) {
  try {
    const body = { [key]: value };
    const r = await api("PUT", "/api/prompts", body);
    if (!r.ok) {
      toast(r.error || `保存失败: ${key}`, false);
    } else if (!silent) {
      toast(`已保存: ${key}`);
    }
    return r.ok;
  } catch (e) {
    toast(`保存 ${key} 失败: ${e.message}`, false);
    return false;
  }
}

async function renderPrompts() {
  const [pd, pf] = await Promise.all([get("/api/prompts"), get("/api/profiles")]);
  const p = pd.prompts || {};
  const profiles = pf.profiles || [];
  // Always initialize RAG keyword edits from fresh server data
  window._ragKwEdits = JSON.parse(JSON.stringify(p.ragKeywords || {}));

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

  // Number inputs: auto-save on change with debounce
  const debouncedSaveNum = debounce(async (el) => {
    const key = el.dataset.key;
    if (!key) return;
    let val = Number(el.value);
    if (el.dataset.ms === 'h') val = fromH(val);
    else if (el.dataset.ms === 'd') val = fromD(val);
    else if (el.dataset.ms === '1') val = fromS(val);
    await savePromptField(key, val, true);
  }, 300);

  content.querySelectorAll('.prompts-editable').forEach(el => {
    if (el.classList.contains('prompts-num')) {
      el.addEventListener('change', () => debouncedSaveNum(el));
    } else if (el.tagName === 'TEXTAREA' && !el.classList.contains('prompts-textarea')) {
      // Array textarea (e.g. dailyShareDefaultCancelIf) — auto-save on change
      const debouncedSaveArr = debounce(async (ta) => {
        const key = ta.dataset.key;
        if (!key) return;
        const lines = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
        await savePromptField(key, lines, true);
      }, 300);
      el.addEventListener('change', () => debouncedSaveArr(el));
    }
  });
  content.querySelectorAll('[data-action="edit-text"]').forEach(btn => {
    btn.addEventListener("click", () => {
      promptsEditing[btn.dataset.key] = true;
      renderPrompts();
    });
  });
  content.querySelectorAll('[data-action="cancel-text"]').forEach(btn => {
    btn.addEventListener("click", () => {
      promptsEditing[btn.dataset.key] = false;
      renderPrompts();
    });
  });
  content.querySelectorAll('[data-action="save-text"]').forEach(btn => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.key;
      const el = content.querySelector(`#prompt_${key}`);
      const val = el ? el.value : '';
      promptsEditing[key] = false;
      await savePromptField(key, val);
      renderPrompts();
    });
  });

  // RAG keyword tab switching
  content.querySelectorAll('[data-kwgroup]').forEach(btn => {
    btn.addEventListener("click", () => {
      window._ragKwActiveGroup = btn.dataset.kwgroup;
      window._ragKwEditingIdx = undefined;
      renderPrompts();
    });
  });
  // RAG keyword chip: delete — save immediately
  content.querySelectorAll('[data-action="kw-delete"]').forEach(btn => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.dataset.kwidx);
      const activeGroup = window._ragKwActiveGroup || "lore";
      const current = getRagKw(activeGroup);
      current.splice(idx, 1);
      setRagKw(activeGroup, current);
      await savePromptField("ragKeywords", JSON.parse(JSON.stringify(window._ragKwEdits)));
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
  // RAG keyword: save inline edit (Enter key or OK button) — save immediately
  content.querySelectorAll('[data-action="kw-save-inline"]').forEach(el => {
    const handler = async () => {
      const idx = Number(el.dataset.kwidx);
      const activeGroup = window._ragKwActiveGroup || "lore";
      const input = content.querySelector(`.rag-kw-chip-input[data-kwidx="${idx}"]`);
      const newVal = (input?.value || "").trim();
      if (newVal) {
        const current = getRagKw(activeGroup);
        current[idx] = newVal;
        setRagKw(activeGroup, current);
        await savePromptField("ragKeywords", JSON.parse(JSON.stringify(window._ragKwEdits)));
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
  // RAG keyword: add new — save immediately
  content.querySelectorAll('[data-action="kw-add"]').forEach(input => {
    input.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const val = input.value.trim();
        if (!val) return;
        const activeGroup = window._ragKwActiveGroup || "lore";
        const current = getRagKw(activeGroup);
        current.push(val);
        setRagKw(activeGroup, current);
        await savePromptField("ragKeywords", JSON.parse(JSON.stringify(window._ragKwEdits)));
        input.value = "";
        renderPrompts();
      }
    });
  });
}


function switchTab(name) {
  tabs.forEach(b => b.classList.remove("active"));
  const target = document.querySelector(`nav button[data-tab="${name}"]`);
  if (target) target.classList.add("active");
  activeTab = name;
  render();
}

let promptsEditing = {};

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
    </div>

    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-sys"><span>阶段 1 — 稳定 System Context</span></div>
        ${renderPipelineStep({
          n: 1,
          title: "Profile",
          desc: "",
          wide: true,
          body: profileTable,
        })}
        ${renderPipelineStep({
          n: 2,
          title: "表达能力",
          desc: "",
          body: `
            <label class="pipeline-sub-label">表达能力</label>
            ${renderTextPreview("expressionCapability", p.expressionCapability)}
          `,
        })}
        ${renderPipelineStep({
          n: 3,
          title: "长期记忆 (System Prompt)",
          desc: "通过 --append-system-prompt-file 注入 system prompt，Claude 自动缓存，不占 turn body。",
          body: `
            <label class="pipeline-sub-label">记忆上下文指令</label>
            ${renderTextPreview("memoryContextInstruction", p.memoryContextInstruction)}
          `,
        })}
      </div>
    </div>

    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-body"><span>阶段 2 — 动态上下文</span></div>
        ${renderPipelineStep({
          n: 4,
          title: "Hidden-world 输出",
          desc: "",
          body: `
            <p style="color:var(--muted);font-size:13px;margin:0 0 8px">注入了 worldState（currentPlan、openThreads）、inner_scenelet 场景叙事、以及全部 life_arc 简述（title / kind / current_state / next_useful_moment）。</p>
            <label class="pipeline-sub-label">Inner Scenelet 引导说明</label>
            ${renderTextPreview("innerSceneletIntro", p.innerSceneletIntro)}
            <label class="pipeline-sub-label">Inner Scenelet 正文</label>
            <button class="btn" onclick="switchTab('world')" style="margin:8px 0">前往 Hidden World 页配置 →</button>
            <label class="pipeline-sub-label">Scenelet 到回复桥接指令</label>
            ${renderTextPreview("sceneletReplyBridgeInstruction", p.sceneletReplyBridgeInstruction)}
          `,
        })}
        ${renderPipelineStep({
          n: 5,
          title: "RAG",
          desc: "",
          body: `
            ${renderRagKeywordChips(p)}
            <label class="pipeline-sub-label">RAG 上下文说明</label>
            ${renderTextPreview("ragContextInstruction", p.ragContextInstruction)}
            ${renderControlGrid([
              renderNumberControl("ragTopK", "Top-K", p.ragTopK || 6, 1, 20, "docs"),
              renderNumberControl("ragMinScore", "最低分数", p.ragMinScore || 0.48, 0, 1, "score", { step: "0.01" }),
              renderNumberControl("ragResultMaxChars", "最大字符数", p.ragResultMaxChars || 3600, 500, 10000, "chars"),
              renderNumberControl("ragTimeoutMs", "超时", p.ragTimeoutMs, 5, 120, "s", { ms: true }),
            ])}
          `,
        })}
        ${renderPipelineStep({
          n: 6,
          title: "聊天风格及现实",
          desc: "",
          body: `
            <label class="pipeline-sub-label">聊天风格</label>
            ${renderTextPreview("chatStyle", p.chatStyle)}
            <label class="pipeline-sub-label">聊天现实</label>
            ${renderTextPreview("chatRealityInstructions", p.chatRealityInstructions)}
          `,
        })}
        ${renderPipelineStep({
          n: 7,
          title: "用户消息",
          desc: "",
          body: `
            <label class="pipeline-sub-label">Vision Caption Prompt</label>
            ${renderTextPreview("visionCaptionPrompt", p.visionCaptionPrompt)}
          `,
        })}
      </div>
    </div>

    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-model"><span>阶段 3 — 输出及memory维护</span></div>
        ${renderPipelineStep({
          n: 8,
          title: "模型调用与输出",
          desc: "",
          body: `<p style="color:var(--muted);font-size:13px;margin:0">由上游控件组合最终 prompt，经模型生成回复后流式切分发送；成功轮次触发 memory 候选抽取与合并写入。</p>`,
        })}
        ${renderPipelineStep({
          n: 9,
          title: "Memory Writer",
          desc: "",
          body: `
            <label class="pipeline-sub-label">候选抽取指令</label>
            ${renderTextPreview("memoryCandidateInstructions", p.memoryCandidateInstructions)}
            <label class="pipeline-sub-label" style="margin-top:12px">合并规划指令</label>
            ${renderTextPreview("memoryWriterInstructions", p.memoryWriterInstructions)}
            <label class="pipeline-sub-label" style="margin-top:12px">记忆处理超时</label>
            ${renderControlGrid([
              renderNumberControl("memoryCandidateTimeoutMs", "候选抽取超时", p.memoryCandidateTimeoutMs, 10, 180, "s", { ms: true }),
              renderNumberControl("memoryMergeTimeoutMs", "合并决策超时", p.memoryMergeTimeoutMs, 30, 300, "s", { ms: true }),
            ])}
          `,
        })}
      </div>
    </div>
  `;
}

function renderPipelineStep({ n, title, desc, body = "", wide = false }) {
  return `
    <div class="pipeline-row${wide ? " pipeline-row-wide" : ""}">
      <div class="pipeline-left">
        <div class="pipeline-field">
          <div class="pipeline-field-head">
            <span class="pipeline-field-label">${String(n).padStart(2, "0")} ${escHtml(title)}</span>
          </div>
          ${body}
        </div>
      </div>
    </div>
  `;
}

function renderPipelineMeta(items = []) {
  return "";
}

function renderControlGrid(items = []) {
  return `<div class="pipeline-control-grid">${items.join("")}</div>`;
}

function renderArrayTextarea(key, label, value) {
  const text = Array.isArray(value) ? value.join("\n") : String(value || "");
  return `
    <label class="pipeline-control pipeline-control-wide">
      <span>${escHtml(label)}</span>
      <textarea id="prompt_${key}" class="prompts-editable" data-key="${key}" rows="3" style="width:100%;min-height:50px;font-size:12px" placeholder="每行一条">${escHtml(text)}</textarea>
    </label>
  `;
}

function renderNumberControl(key, label, value, min, max, unit, options = {}) {
  let displayValue = value ?? '';
  if (typeof options.ms === 'string') {
    if (options.ms === 'h') displayValue = toH(value);
    else if (options.ms === 'd') displayValue = toD(value);
  } else if (options.ms) {
    displayValue = toS(value);
  }
  const msAttr = typeof options.ms === 'string' ? options.ms : (options.ms ? '1' : '');
  const attrs = [
    `id="prompt_${key}"`,
    `class="prompts-editable prompts-num"`,
    `type="number"`,
    `min="${escAttr(min)}"`,
    `max="${escAttr(max)}"`,
    options.step ? `step="${escAttr(options.step)}"` : "",
    `value="${escAttr(displayValue ?? '')}"`,
    `data-key="${escAttr(key)}"`,
    msAttr ? `data-ms="${msAttr}"` : "",
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
  if (isOpen) {
    const h = key === 'sceneletInstructions' || key === 'proactiveInstructions' || key === 'memoryCandidateInstructions' || key === 'memoryWriterInstructions' || key === 'scheduleCreatorInstructions' ? '220px' : '110px';
    return `<textarea id="prompt_${key}" class="prompts-editable prompts-textarea" data-key="${key}" style="min-height:${h}">${escHtml(value || '')}</textarea>
      <div class="editor-actions" style="margin-top:4px">
        <button class="btn btn-primary" data-action="save-text" data-key="${key}">保存</button>
        <button class="btn" data-action="cancel-text" data-key="${key}">取消</button>
      </div>`;
  }
  const preview = value || '(empty)';
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
  return "";
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
        <div class="memory-toolbar">
          <select id="worldProfileSelect">${profiles.map(name => `<option value="${escAttr(name)}"${name === role.profile ? " selected" : ""}>${escHtml(name)}</option>`).join("")}</select>
          <button class="btn" data-action="open-world-reset">Reset / Edit Snapshot</button>
        </div>
      </div>
	    </div>

    ${renderWorldPipeline(role, p)}

  `;
  bindWorldEvents();
  bindSeasonalEditorEvents();
  bindPromptEditorEvents(renderWorld);
}

function renderWorldPipeline(role, p) {
  const world = role.worldSession || {};
  const usage = world.lastUsage || {};
  return `
    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-sys"><span>阶段 1 — System Prompt</span></div>
        ${renderPipelineStep({
          n: 1,
          title: "Profile",
          desc: "",
          body: `<p style="color:var(--muted);font-size:13px;margin:0">读取 profile template 构建角色底座，目标是世界连续性而非最终措辞。</p>`,
        })}
        ${renderPipelineStep({
          n: 2,
          title: "Scenelet 指令",
          desc: "驱动 inner_scenelet 叙事 + world_state 更新 + follow_up 候选。daily_share 已解耦给 Seed，schedule 已解耦给 Extractor。",
          body: `
            <label class="pipeline-sub-label">Scenelet 生成指令</label>
            ${renderTextPreview("sceneletInstructions", p.sceneletInstructions)}
          `,
        })}
        ${renderPipelineStep({
          n: 3,
          title: "背景补充",
          desc: "",
          body: `
            <label class="pipeline-sub-label">特殊日期</label>
            ${renderScheduleCalendar(p.scheduleSpecialDates || '')}
            <label class="pipeline-sub-label">月度行事</label>
            ${renderSeasonalEditor(p)}
          `,
        })}
        ${renderPipelineStep({
          n: 4,
          title: "长期记忆 (System Prompt)",
          desc: "通过 --append-system-prompt-file 注入 system prompt，自动缓存。",
          body: `
            <label class="pipeline-sub-label">记忆上下文指令</label>
            ${renderTextPreview("memoryContextInstruction", p.memoryContextInstruction)}
          `,
        })}
      </div>
    </div>

    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-body"><span>阶段 2 — 动态上下文</span></div>
        ${renderPipelineStep({
          n: 5,
          title: "最近可见聊天窗口",
          desc: "",
          body: `
            <label class="pipeline-sub-label">聊天历史引导说明</label>
            ${renderTextPreview("chatHistoryIntro", p.chatHistoryIntro)}
            ${renderControlGrid([
              renderNumberControl("visibleContextTurns", "可见轮次数", p.visibleContextTurns || 8, 1, 30, "turns"),
            ])}
          `,
        })}
        ${renderPipelineStep({
          n: 6,
          title: "语言风格约束",
          desc: "",
          body: `
            <label class="pipeline-sub-label">语言风格约束</label>
            ${renderTextPreview("hiddenWorldChatStyle", p.hiddenWorldChatStyle)}
          `,
        })}
        ${renderPipelineStep({
          n: 7,
          title: "时间戳 + Web/Search Guard",
          desc: "",
          body: `<p style="color:var(--muted);font-size:13px;margin:0">currentTimeContext() 提供双时区时间戳；WebSearch/WebFetch 权限规则在 sceneletInstructions 中定义。</p>`,
        })}
      </div>
    </div>

    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-model"><span>阶段 3 — 输出</span></div>
        ${renderPipelineStep({
          n: 8,
          title: "Inner Scenelet",
          desc: "",
          body: `<p style="color:var(--muted);font-size:13px;margin:0">hidden-world 每轮输出的角色内在叙事文本，供主回复读取以保持角色一致性和生活连续性。</p>`,
        })}
        ${renderPipelineStep({
          n: 9,
          title: "Follow-up Candidates",
          desc: "",
          body: `
            <p style="color:var(--muted);font-size:13px;margin:0 0 8px">每轮从对话中生长出的主动意图候选（如面试前关心、未完成话题的自然延续等）。daily_share 已解耦给独立 Seed 模块，schedule 已解耦给 Extractor 模块。</p>
            ${renderControlGrid([
              renderNumberControl("hiddenWorldMaxPendingIntents", "最大待处理意图展示", p.hiddenWorldMaxPendingIntents || 8, 1, 20, "条"),
              renderNumberControl("maxFollowUpCandidatesPerTurn", "每轮最大候选数", p.maxFollowUpCandidatesPerTurn || 3, 0, 10, "条"),
            ])}
          `,
        })}
        ${renderPipelineStep({
          n: 10,
          title: "World State Patch",
          desc: "",
          body: `<p style="color:var(--muted);font-size:13px;margin:0">结构化快照：location / activity / awake_state / current_plan / open_threads / last_world_event_at。具体内容在 Reset 快照页编辑。</p>`,
        })}
      </div>
    </div>

    <div class="panel">
      <div class="pipeline-phase-box">
        <div class="pipeline-phase-label phase-post"><span>阶段 4 — 后台主动子系统</span></div>
        ${renderPipelineStep({
          n: 11,
          title: "Schedule Extractor",
          desc: "每轮从本轮消息 + inner_scenelet 中提取新的周期性/持续性候选，去重后累积到待审批队列。",
          body: `
            <label class="pipeline-sub-label">Extractor Prompt</label>
            ${renderTextPreview("scheduleExtractorPrompt", p.scheduleExtractorPrompt)}
          `,
        })}
        ${renderPipelineStep({
          n: 12,
          title: "Life Arc 审批 (Schedule Creator)",
          desc: "定期审批 Extractor 积累的候选队列。审批标准：不从单次推断周期性、null time 不批。处理后清空队列。",
          body: `
            <label class="pipeline-sub-label">审批 Prompt</label>
            ${renderTextPreview("scheduleCreatorInstructions", p.scheduleCreatorInstructions)}
            <label class="pipeline-sub-label">调度参数</label>
            ${renderControlGrid([
              renderNumberControl("scheduleCheckIntervalMs", "审批间隔", p.scheduleCheckIntervalMs, 600, 604800, "s", { ms: true }),
              renderNumberControl("scheduleMaxActive", "最大活跃 arc", p.scheduleMaxActive || 2, 1, 5, "条"),
              renderNumberControl("scheduleFinalizationTimeoutMs", "审批超时", p.scheduleFinalizationTimeoutMs, 10, 300, "s", { ms: true }),
              renderNumberControl("scheduleRecentKindsLimit", "最近类型回溯", p.scheduleRecentKindsLimit || 5, 1, 20, "条"),
              renderNumberControl("schedulePromptProfileMaxChars", "Profile 截取", p.schedulePromptProfileMaxChars || 800, 200, 3000, "字符"),
              renderNumberControl("scheduleBasisMaxLength", "理由上限", p.scheduleBasisMaxLength || 300, 50, 1000, "字符"),
              renderNumberControl("scheduleArcTitleMaxLength", "标题上限", p.scheduleArcTitleMaxLength || 80, 20, 200, "字符"),
              renderNumberControl("scheduleArcSummaryMaxLength", "摘要上限", p.scheduleArcSummaryMaxLength || 500, 100, 2000, "字符"),
              renderNumberControl("scheduleExpiryAfterEndBufferMs", "结束后缓冲", p.scheduleExpiryAfterEndBufferMs, 1, 24, "h", { ms: 'h' }),
              renderNumberControl("scheduleDefaultExpiryFromNowMs", "默认到期", p.scheduleDefaultExpiryFromNowMs, 1, 7, "d", { ms: 'd' }),
            ])}
          `,
        })}
        ${renderPipelineStep({
          n: 13,
          title: "Daily Share Seed",
          desc: "沉默期独立创意种子。完全解耦对话上下文，只用时间/天气/位置/活动作为素材。Pro 模型运行。",
          body: `
            <label class="pipeline-sub-label">Seed Prompt</label>
            ${renderTextPreview("dailyShareSeedPrompt", p.dailyShareSeedPrompt)}
            <label class="pipeline-sub-label">调度参数</label>
            ${renderControlGrid([
              renderNumberControl("dailyShareSeedIntervalMs", "Seed 间隔", p.dailyShareSeedIntervalMs, 600, 86400, "s", { ms: true }),
              renderNumberControl("dailyShareMinIdleMs", "最小沉默时间", p.dailyShareMinIdleMs, 300, 86400, "s", { ms: true }),
              renderNumberControl("dailyShareDefaultScheduleOffsetMs", "默认延迟", p.dailyShareDefaultScheduleOffsetMs, 60, 1800, "s", { ms: true }),
              renderNumberControl("dailyShareDefaultExpiryOffsetMs", "默认过期", p.dailyShareDefaultExpiryOffsetMs, 300, 7200, "s", { ms: true }),
            ])}
            ${renderArrayTextarea("dailyShareDefaultCancelIf", "默认取消条件（每行一条）", p.dailyShareDefaultCancelIf)}
          `,
        })}
        ${renderPipelineStep({
          n: 14,
          title: "Proactive 二次判断",
          desc: "",
          body: `
            <label class="pipeline-sub-label">Proactive 二次判断指令</label>
            ${renderTextPreview("proactiveInstructions", p.proactiveInstructions)}
            ${renderControlGrid([
              renderNumberControl("proactiveCheckIntervalMs", "检查间隔", p.proactiveCheckIntervalMs, 5, 300, "s", { ms: true }),
              renderNumberControl("proactiveCooldownMs", "冷却时间", p.proactiveCooldownMs, 60, 86400, "s", { ms: true }),
              renderNumberControl("proactiveDailyMax", "每日上限", p.proactiveDailyMax || 8, 1, 24, "条"),
              renderNumberControl("proactiveDefaultExpiryOffsetMs", "默认过期偏移", p.proactiveDefaultExpiryOffsetMs, 300, 7200, "s", { ms: true }),
            ])}
          `,
        })}
      </div>
    </div>
  `;
}

// ====== Schedule Calendar ======

let scState = {
  viewYear: new Date().getFullYear(),
  viewMonth: new Date().getMonth() + 1,
  selected: null,
  fixed: [],
  floating: []
};
let scInputTimer = null;

const WEEKDAY_MAP = { "星期一": 1, "星期二": 2, "星期三": 3, "星期四": 4, "星期五": 5, "星期六": 6, "星期日": 0 };
const WEEKDAY_NAMES = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const WEEK_NUM_MAP = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5 };
const WEEK_NUM_LABELS = ["一", "二", "三", "四", "五"];

function weekNumToChinese(n) {
  return WEEK_NUM_LABELS[n - 1] || String(n);
}

function calcFloatingDate(month, weekNum, weekdayName, year) {
  const targetDay = WEEKDAY_MAP[weekdayName];
  if (targetDay === undefined) return null;
  const firstDay = new Date(year, month - 1, 1);
  const firstTargetDay = 1 + ((targetDay - firstDay.getDay() + 7) % 7);
  const result = firstTargetDay + (weekNum - 1) * 7;
  if (result > new Date(year, month, 0).getDate()) return null;
  return result;
}

function parseSpecialDates(text) {
  const fixed = [];
  const floating = [];
  const lines = String(text || "").split("\n").filter(Boolean);
  for (const line of lines) {
    const mFixed = line.match(/^(\d{1,2})月(\d{1,2})日[：:](.+)/);
    if (mFixed) {
      fixed.push({ month: +mFixed[1], day: +mFixed[2], desc: mFixed[3].trim() });
      continue;
    }
    const mFloat = line.match(/^(\d{1,2})月第([\d一二三四五])个?(星期[一二三四五六日])[：:](.+)/);
    if (mFloat) {
      const weekNum = WEEK_NUM_MAP[mFloat[2]] ?? parseInt(mFloat[2], 10);
      floating.push({ month: +mFloat[1], weekNum, weekday: mFloat[3], desc: mFloat[4].trim(), raw: line.trim() });
      continue;
    }
    if (line.includes(`：`) || line.includes(":")) floating.push({ raw: line.trim() });
  }
  return { fixed, floating };
}

function serializeSpecialDates(fixed, floating) {
  const lines = [];
  for (const f of fixed) {
    const m = String(f.month).padStart(2, '0');
    const d = String(f.day).padStart(2, '0');
    lines.push(`${m}月${d}日：${f.desc}`);
  }
  for (const f of floating) {
    if (f.raw && f.weekNum === undefined) {
      lines.push(f.raw);
    } else {
      lines.push(`${f.month}月第${weekNumToChinese(f.weekNum)}个${f.weekday}：${f.desc}`);
    }
  }
  return lines.join('\n');
}

function scDateKey(month, day) {
  return `${month}-${day}`;
}

function scEntryForDate(month, day) {
  return scState.fixed.find(e => e.month === month && e.day === day) || null;
}

function scFloatingForDate(month, day, year) {
  return scState.floating.filter(f => {
    if (f.weekNum === undefined) return false;
    const d = calcFloatingDate(f.month, f.weekNum, f.weekday, year);
    return d === day && f.month === month;
  });
}

function renderSeasonalEditor(p) {
  const val = p.seasonalMonthlyNotes || {};
  const jsonStr = JSON.stringify(val, null, 2);
  const months = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
  return `
    <button id="openSeasonalEditor" class="btn" style="margin-top:6px">编辑月度行事</button>
    <textarea id="snap_seasonalMonthlyNotes" class="prompts-editable" data-key="seasonalMonthlyNotes" style="display:none" aria-hidden="true">${escHtml(jsonStr)}</textarea>
    <div class="seasonal-overlay" id="seasonalOverlay" style="display:none">
      <div class="seasonal-modal">
        <div class="seasonal-head">
          <span class="seasonal-title">编辑月度行事（每月可有多条，一行一条）</span>
          <button id="closeSeasonalEditor" class="btn" style="min-height:26px;padding:2px 10px">&times;</button>
        </div>
        <div class="seasonal-body">
          ${months.map((label, i) => {
            const items = Array.isArray(val[String(i+1)]) ? val[String(i+1)] : [];
            return `<div class="seasonal-month"><label>${label}</label><textarea class="seasonal-month-ta" data-month="${i+1}" rows="5">${escHtml(items.join('\n'))}</textarea></div>`;
          }).join('')}
        </div>
        <div class="seasonal-foot">
          <button id="saveSeasonalEditor" class="btn btn-primary" style="margin-top:8px">保存</button>
          <button id="cancelSeasonalEditor" class="btn" style="margin-top:8px">取消</button>
        </div>
      </div>
    </div>
  `;
}

function bindSeasonalEditorEvents() {
  const overlay = document.getElementById('seasonalOverlay');
  const openBtn = document.getElementById('openSeasonalEditor');
  const closeBtn = document.getElementById('closeSeasonalEditor');
  const saveBtn = document.getElementById('saveSeasonalEditor');
  const cancelBtn = document.getElementById('cancelSeasonalEditor');
  const hiddenTa = document.getElementById('snap_seasonalMonthlyNotes');
  if (!overlay || !openBtn || !hiddenTa) return;

  openBtn.addEventListener('click', () => { overlay.style.display = 'flex'; });
  closeBtn.addEventListener('click', () => { overlay.style.display = 'none'; });
  cancelBtn.addEventListener('click', () => { overlay.style.display = 'none'; });
  saveBtn.addEventListener('click', async () => {
    const data = {};
    for (let i = 1; i <= 12; i++) {
      const ta = overlay.querySelector('.seasonal-month-ta[data-month=\"' + i + '\"]');
      const lines = (ta?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
      if (lines.length) data[String(i)] = lines;
    }
    overlay.style.display = 'none';
    await savePromptField('seasonalMonthlyNotes', data);
  });
}

function renderScheduleCalendar(currentValue) {
  const val = currentValue || '';
  const parsed = parseSpecialDates(val);
  const n = parsed.fixed.length + parsed.floating.length;

  return `
    <button id="openScheduleCalendar" class="btn sc-open-btn">编辑特殊日期 (${n})</button>
    <textarea id="snap_scheduleSpecialDates" class="prompts-editable" data-key="scheduleSpecialDates" style="display:none" aria-hidden="true">${escHtml(val)}</textarea>
    <div class="sc-overlay" id="scheduleCalendarOverlay" style="display:none">
      <div class="sc-modal">
        <div class="sc-head">
          <span class="sc-title">编辑特殊日期</span>
          <button id="closeScheduleCalendar" class="btn sc-close-btn">&times;</button>
        </div>
        <div class="sc-body">
          <div class="sc-calendar">
            <div class="sc-month-nav">
              <button id="scPrevMonth" class="btn sc-nav-btn">&larr;</button>
              <span id="scMonthLabel" class="sc-month-label"></span>
              <button id="scNextMonth" class="btn sc-nav-btn">&rarr;</button>
            </div>
            <div class="sc-weekdays" id="scWeekdays"></div>
            <div class="sc-days" id="scDays"></div>
          </div>
          <div class="sc-right" id="scEditPanel">
            <div class="sc-edit-empty">选择日期以编辑描述</div>
          </div>
        </div>
        <div class="sc-floating-list" id="scFloatingList"></div>
        <div class="sc-foot">
          <button id="scSaveCalendar" class="btn btn-primary">保存</button>
          <button id="scCancelCalendar" class="btn">取消</button>
        </div>
      </div>
    </div>
  `;
}

function scRefreshCalendar() {
  scRefreshDays();
  scRefreshEditPanel();
  scRefreshFloating();
}

function scRefreshDays() {
  const monthLabel = document.getElementById('scMonthLabel');
  if (monthLabel) monthLabel.textContent = `${scState.viewMonth}月`;

  const weekdays = document.getElementById('scWeekdays');
  if (weekdays) {
    weekdays.innerHTML = ['日', '一', '二', '三', '四', '五', '六']
      .map(d => `<div class="sc-weekday">${d}</div>`).join('');
  }

  const daysEl = document.getElementById('scDays');
  if (!daysEl) return;

  const { viewYear, viewMonth, selected } = scState;
  const firstDay = new Date(viewYear, viewMonth - 1, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;

  let html = '';
  for (let i = 0; i < firstDay; i++) {
    html += '<div class="sc-day sc-day-empty"></div>';
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dk = scDateKey(viewMonth, d);
    const entry = scEntryForDate(viewMonth, d);
    const floatEntries = scFloatingForDate(viewMonth, d, viewYear);
    const cellDateStr = `${viewYear}-${viewMonth}-${d}`;
    let cls = 'sc-day';
    if (entry) cls += ' sc-day-fixed';
    if (floatEntries.length) cls += ' sc-day-floating';
    if (selected === dk) cls += ' sc-day-selected';
    if (cellDateStr === todayStr) cls += ' sc-day-today';
    const titles = [];
    if (entry) titles.push(entry.desc);
    for (const f of floatEntries) titles.push(f.desc);
    const titleAttr = titles.length ? ` title="${escAttr(titles.join('; '))}"` : '';
    html += `<div class="${cls}" data-sc-day="${d}" data-sc-month="${viewMonth}"${titleAttr}>${d}</div>`;
  }
  daysEl.innerHTML = html;
}

function scRefreshEditPanel() {
  const panel = document.getElementById('scEditPanel');
  if (!panel) return;

  const { selected, viewYear, viewMonth } = scState;
  if (!selected) {
    panel.innerHTML = '<div class="sc-edit-empty">选择日期以编辑描述</div>';
    return;
  }

  const [sm, sd] = selected.split('-').map(Number);
  const entry = scEntryForDate(sm, sd);
  const desc = entry ? entry.desc : '';
  const floatEntries = scFloatingForDate(sm, sd, viewYear);

  let floatHtml = '';
  if (floatEntries.length) {
    const items = floatEntries.map((f, i) => {
      const label = `${f.month}月第${weekNumToChinese(f.weekNum)}个${f.weekday}：${f.desc}`;
      return `<span class="sc-float-tag" title="${escAttr(label)}">${escHtml(f.desc)}</span>`;
    }).join('');
    floatHtml = `<div class="sc-float-tags">${items}</div>`;
  }

  panel.innerHTML = `
    <div class="sc-edit-label">${sm}月${sd}日</div>
    <textarea id="scDescInput" class="sc-desc-input" placeholder="输入固定日期描述...">${escHtml(desc)}</textarea>
    <div class="sc-edit-actions">
      <button id="scDeleteDate" class="btn btn-danger sc-del-btn"${entry ? '' : ' disabled'}>删除描述</button>
    </div>
    ${floatHtml}
    <div class="sc-add-float-section">
      <button class="btn sc-add-float-btn" id="scAddFloat">+ 添加浮动日期到此月</button>
      <div class="sc-float-form" id="scFloatForm" style="display:none">
        ${buildFloatFormHtml(viewMonth)}
        <button class="btn" id="scFloatSave">保存</button>
        <button class="btn sc-cancel-btn" id="scFloatCancel">取消</button>
      </div>
    </div>
  `;

  const input = document.getElementById('scDescInput');
  const delBtn = document.getElementById('scDeleteDate');

  if (input) {
    input.addEventListener('input', () => {
      clearTimeout(scInputTimer);
      scInputTimer = setTimeout(() => {
        const val = input.value.trim();
        const [m, d] = selected.split('-').map(Number);
        const idx = scState.fixed.findIndex(e => e.month === m && e.day === d);
        if (val) {
          if (idx >= 0) scState.fixed[idx].desc = val;
          else scState.fixed.push({ month: m, day: d, desc: val });
        } else {
          if (idx >= 0) scState.fixed.splice(idx, 1);
        }
        scRefreshDays();
        scRefreshFloating();
        scUpdateButtonCount();
        if (delBtn) delBtn.disabled = !val;
      }, 200);
    });
  }

  if (delBtn) {
    delBtn.addEventListener('click', () => {
      const [m, d] = selected.split('-').map(Number);
      const idx = scState.fixed.findIndex(e => e.month === m && e.day === d);
      if (idx >= 0) {
        scState.fixed.splice(idx, 1);
        scState.selected = null;
        scRefreshCalendar();
      }
    });
  }

  // Add floating date form events
  const addFloatBtn = document.getElementById('scAddFloat');
  const floatForm = document.getElementById('scFloatForm');
  const floatCancel = document.getElementById('scFloatCancel');
  const floatSave = document.getElementById('scFloatSave');

  if (addFloatBtn && floatForm) {
    addFloatBtn.addEventListener('click', () => {
      floatForm.style.display = floatForm.style.display === 'none' ? 'flex' : 'none';
    });
  }
  if (floatCancel && floatForm) {
    floatCancel.addEventListener('click', () => {
      floatForm.style.display = 'none';
    });
  }
  if (floatSave) {
    floatSave.addEventListener('click', () => {
      const fMonth = parseInt(document.getElementById('scFloatMonth')?.value);
      const fWeekNum = parseInt(document.getElementById('scFloatWeek')?.value);
      const fWeekday = document.getElementById('scFloatDay')?.value;
      const fDesc = document.getElementById('scFloatDesc')?.value.trim();
      if (!fMonth || !fWeekNum || !fWeekday || !fDesc) {
        toast('请填写完整的浮动日期信息', false);
        return;
      }
      const raw = `${fMonth}月第${weekNumToChinese(fWeekNum)}个${fWeekday}：${fDesc}`;
      scState.floating.push({ month: fMonth, weekNum: fWeekNum, weekday: fWeekday, desc: fDesc, raw });
      if (floatForm) floatForm.style.display = 'none';
      scRefreshCalendar();
    });
  }
}

function buildFloatFormHtml(defaultMonth) {
  const months = Array.from({ length: 12 }, (_, i) =>
    `<option value="${i + 1}"${i + 1 === defaultMonth ? ' selected' : ''}>${i + 1}</option>`
  ).join('');
  const weeks = WEEK_NUM_LABELS.map((w, i) =>
    `<option value="${i + 1}">${w}</option>`
  ).join('');
  const days = WEEKDAY_NAMES.map(d =>
    d === "星期日" ? `<option value="${d}">${d}</option>` :
    `<option value="${d}">${d}</option>`
  ).join('');
  return `<span class="sc-float-group"><select id="scFloatMonth">${months}</select><span class="sc-float-label">月</span></span><span class="sc-float-group"><span class="sc-float-label">第</span><select id="scFloatWeek">${weeks}</select><span class="sc-float-label">个</span></span><span class="sc-float-group"><select id="scFloatDay">${days}</select></span><input id="scFloatDesc" class="sc-float-desc" placeholder="描述">`;
}

function scRefreshFloating() {
  const el = document.getElementById('scFloatingList');
  if (!el) return;
  const { fixed, floating, viewYear } = scState;
  const fixCount = fixed.length;
  const floatCount = floating.length;
  const all = [
    ...fixed.map((d, i) => ({ type: 'fixed', index: i, sort: d.month * 100 + d.day, label: `${d.month}月${d.day}日：${d.desc}` })),
    ...floating.map((f, i) => {
      let label = '';
      let sort = f.month * 100;
      if (f.weekNum !== undefined) {
        const calcDay = calcFloatingDate(f.month, f.weekNum, f.weekday, viewYear);
        if (calcDay !== null) sort = f.month * 100 + calcDay;
        const dayStr = calcDay !== null ? `（今年${f.month}月${calcDay}日）` : '';
        label = `${f.month}月第${weekNumToChinese(f.weekNum)}个${f.weekday}：${f.desc}${dayStr}`;
      } else {
        label = f.raw || '';
      }
      return { type: 'floating', index: i, sort, label };
    }),
  ];
  all.sort((a, b) => a.sort - b.sort);
  if (all.length) {
    el.innerHTML = `
    <div class="sc-floating-head">
      <span class="sc-floating-head-label">全部日期 &middot; ${all.length}</span>
      <span class="sc-floating-filters">
        <span class="sc-flt active" data-filter="all">全部</span>
        <span class="sc-flt" data-filter="fixed">固定 &middot; ${fixCount}</span>
        <span class="sc-flt" data-filter="floating">浮动 &middot; ${floatCount}</span>
      </span>
    </div>
    <div class="sc-floating-body">
      ${all.map(d => {
        const parts = d.label.split(/[：:]/);
        const datePart = parts[0] || '';
        const descPart = parts.slice(1).join('：') || '';
        return `
        <div class="sc-floating-item" data-type="${d.type}">
          <span class="sc-date-label">${escHtml(datePart)}</span>
          <span class="sc-date-desc" title="${escHtml(descPart)}">${escHtml(descPart)}</span>
          ${d.type === 'floating' ? `<button class="btn btn-danger sc-floating-del" data-sc-fi="${d.index}">删除</button>` : ''}
        </div>
      `}).join('')}
    </div>
  `;
  // Delete buttons for floating dates
  el.querySelectorAll('.sc-floating-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.scFi);
      scState.floating.splice(i, 1);
      scRefreshCalendar();
      scUpdateButtonCount();
    });
  });
  // Filter tabs
  el.querySelectorAll('.sc-flt').forEach(flt => {
    flt.addEventListener('click', () => {
      el.querySelectorAll('.sc-flt').forEach(s => s.classList.remove('active'));
      flt.classList.add('active');
      const filter = flt.dataset.filter;
      el.querySelectorAll('.sc-floating-item').forEach(item => {
        item.style.display = (filter === 'all' || item.dataset.type === filter) ? '' : 'none';
      });
    });
  });
  }
}

function scSyncToTextarea() {
  const ta = document.getElementById('snap_scheduleSpecialDates');
  if (ta) {
    ta.value = serializeSpecialDates(scState.fixed, scState.floating);
  }
}

function scOpenCalendar() {
  const ta = document.getElementById('snap_scheduleSpecialDates');
  const val = (ta && ta.value !== undefined) ? ta.value : '';
  const parsed = parseSpecialDates(val);
  scState.fixed = parsed.fixed;
  scState.floating = parsed.floating;

  const now = new Date();
  scState.viewYear = now.getFullYear();
  scState.viewMonth = now.getMonth() + 1;
  scState.selected = null;

  const overlay = document.getElementById('scheduleCalendarOverlay');
  if (overlay) overlay.style.display = 'flex';
  scRefreshCalendar();
}

async function scSaveCalendar() {
  scSyncToTextarea();
  const ta = document.getElementById('snap_scheduleSpecialDates');
  if (ta) {
    await savePromptField('scheduleSpecialDates', ta.value);
  }
  scUpdateButtonCount();
  const overlay = document.getElementById('scheduleCalendarOverlay');
  if (overlay) overlay.style.display = 'none';
}

function scUpdateButtonCount() {
  const btn = document.getElementById('openScheduleCalendar');
  if (btn) {
    const n = scState.fixed.length + scState.floating.length;
    btn.textContent = `编辑特殊日期 (${n})`;
  }
}

function scCloseCalendar() {
  const overlay = document.getElementById('scheduleCalendarOverlay');
  if (overlay) overlay.style.display = 'none';
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
        ["lastUsedAt", formatTime(world.lastUsedAt)],
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

  // Schedule Calendar events
  const scOpen = content.querySelector('#openScheduleCalendar');
  const scClose = content.querySelector('#closeScheduleCalendar');
  const scOverlay = content.querySelector('#scheduleCalendarOverlay');
  const scPrev = content.querySelector('#scPrevMonth');
  const scNext = content.querySelector('#scNextMonth');
  const scDays = content.querySelector('#scDays');

  if (scOpen) scOpen.addEventListener('click', scOpenCalendar);
  if (scClose) scClose.addEventListener('click', scCloseCalendar);
  const scSave = content.querySelector('#scSaveCalendar');
  const scCancel = content.querySelector('#scCancelCalendar');
  if (scSave) scSave.addEventListener('click', scSaveCalendar);
  if (scCancel) scCancel.addEventListener('click', scCloseCalendar);
  if (scOverlay) scOverlay.addEventListener('click', (e) => {
    if (e.target === scOverlay) scCloseCalendar();
  });
  if (scPrev) scPrev.addEventListener('click', () => {
    if (scState.viewMonth === 1) {
      scState.viewMonth = 12;
      scState.viewYear--;
    } else {
      scState.viewMonth--;
    }
    scRefreshCalendar();
  });
  if (scNext) scNext.addEventListener('click', () => {
    if (scState.viewMonth === 12) {
      scState.viewMonth = 1;
      scState.viewYear++;
    } else {
      scState.viewMonth++;
    }
    scRefreshCalendar();
  });
  if (scDays) {
    scDays.addEventListener('click', (e) => {
      const dayEl = e.target.closest('.sc-day');
      if (!dayEl || !dayEl.dataset.scDay) return;
      const day = parseInt(dayEl.dataset.scDay);
      const month = parseInt(dayEl.dataset.scMonth);
      scState.selected = scDateKey(month, day);
      scRefreshCalendar();
    });
  }
}

function renderWorldReset(role) {
  const ws = role.worldState || {};
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Reset Hidden World — ${escHtml(role.profile || worldState.resetProfile)}</h2>
        <button class="btn" data-action="cancel-world-reset">Back</button>
      </div>
      <div class="form-grid one">
        <fieldset class="snap-fieldset">
          <legend>world_state</legend>
          <div class="form-grid">
            <div class="form-group"><label>location</label><input id="snap_ws_location" value="${escAttr(ws.location || "")}" placeholder="当前位置"></div>
            <div class="form-group"><label>activity</label><input id="snap_ws_activity" value="${escAttr(ws.activity || "")}" placeholder="当前活动"></div>
            <div class="form-group"><label>awake_state</label><select id="snap_ws_awake">${["awake","sleeping","light_sleep","just_woke","unknown"].map(v => `<option value="${v}"${ws.awake_state === v ? " selected" : ""}>${v}</option>`).join("")}</select></div>
            <div class="form-group"><label>current_plan</label><input id="snap_ws_plan" value="${escAttr(ws.current_plan || "")}" placeholder="接下来几小时的计划"></div>
            <div class="form-group"><label>open_threads</label><textarea id="snap_ws_threads" class="snap-textarea" rows="3" placeholder="每行一个未闭合线索">${escHtml((ws.open_threads || []).join("\n"))}</textarea></div>
            <div class="form-group"><label>last_world_event_at</label><input id="snap_ws_event_at" value="${escAttr(ws.last_world_event_at || "")}" placeholder="ISO string"></div>
          </div>
        </fieldset>
        ${renderLifeArcsEditor(role.lifeArcs || [])}
        ${renderSnapshotTextarea("threadIntents", "thread proactive intents (每个 session 的 proactive intents 数组，通常不需要手动编辑)", role.threadIntents || [])}
        ${(() => {
          const val = role.lastOutput;
          const str = val ? JSON.stringify(val, null, 2) : "";
          return `<div class="form-group"><label>last hidden output (上次 hidden world 完整输出快照，仅供查看)</label><textarea id="snap_lastOutput" class="profile-prompt-editor" spellcheck="false" style="min-height:180px" readonly>${escHtml(str)}</textarea></div>`;
        })()}
        <div class="form-grid">
          <div class="form-group"><label>lastDailyShareSeedAt</label><input id="snap_lastDailyShareSeedAt" value="${escAttr(formatTime(role.lastDailyShareSeedAt))}"></div>
          <div class="form-group"><label>lastScheduleCheckAt</label><input id="snap_lastScheduleCheckAt" value="${escAttr(formatTime(role.lastScheduleCheckAt))}"></div>
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

function renderLifeArcsEditor(arcs) {
  const list = (Array.isArray(arcs) ? arcs : []).filter(a => a.status !== "closed");
  if (!list.length) return `<div class="snap-fieldset"><legend>active life_arcs</legend><p class="muted">暂无活跃 life_arc</p></div>`;
  const kinds = ["travel","work","school","personal","special_date"];
  const cards = list.map((a, i) => `
    <div class="la-card" data-index="${i}">
      <div class="la-card-head">
        <span class="la-card-title">${escHtml(a.title || "(untitled)")}</span>
        <span class="la-card-kind">${escHtml(a.kind || "")}</span>
        <span class="la-card-status">${a.status || "active"}</span>
      </div>
      <div class="la-card-body">
        <div class="form-grid">
          <div class="form-group"><label>title</label><input id="la_${i}_title" value="${escAttr(a.title || "")}"></div>
          <div class="form-group"><label>kind</label><select id="la_${i}_kind">${kinds.map(k => `<option value="${k}"${a.kind === k ? " selected" : ""}>${k}</option>`).join("")}</select></div>
          <div class="form-group"><label>status</label><select id="la_${i}_status"><option value="active"${a.status !== "closed" ? " selected" : ""}>active</option><option value="closed"${a.status === "closed" ? " selected" : ""}>closed</option></select></div>
          <div class="form-group"><label>timeStart</label><input id="la_${i}_ts" value="${escAttr(formatTime(a.timeStart))}" placeholder="ISO"></div>
          <div class="form-group"><label>timeEnd</label><input id="la_${i}_te" value="${escAttr(formatTime(a.timeEnd))}" placeholder="ISO"></div>
          <div class="form-group"><label>expiresAt</label><input id="la_${i}_exp" value="${escAttr(formatTime(a.expiresAt))}" placeholder="ISO"></div>
        </div>
        <div class="form-group"><label>summary</label><textarea id="la_${i}_summary" class="snap-textarea" rows="2">${escHtml(a.summary || "")}</textarea></div>
        <div class="form-group"><label>currentState</label><textarea id="la_${i}_state" class="snap-textarea" rows="2">${escHtml(a.currentState || "")}</textarea></div>
        <div class="form-group"><label>nextUsefulMoment</label><input id="la_${i}_next" value="${escAttr(a.nextUsefulMoment || "")}"></div>
        <div class="form-group"><label>id</label><input id="la_${i}_id" value="${escAttr(a.id || "")}" readonly style="opacity:0.6"></div>
      </div>
    </div>
  `).join("");
  return `<div class="snap-fieldset"><legend>active life_arcs (${list.length})</legend>${cards}</div>`;
}

function renderSnapshotTextarea(id, label, value) {
  return `<div class="form-group"><label>${escHtml(label)}</label><textarea id="snap_${id}" class="profile-prompt-editor" spellcheck="false" style="min-height:180px">${escHtml(JSON.stringify(value || null, null, 2))}</textarea></div>`;
}

async function saveWorldReset() {
  const profile = worldState.resetProfile || worldState.profile;
  const threadsRaw = content.querySelector("#snap_ws_threads")?.value || "";
  const openThreads = threadsRaw.split("\n").map(s => s.trim()).filter(Boolean);
  const worldState = {
    location: content.querySelector("#snap_ws_location")?.value || null,
    activity: content.querySelector("#snap_ws_activity")?.value || null,
    awake_state: content.querySelector("#snap_ws_awake")?.value || null,
    current_plan: content.querySelector("#snap_ws_plan")?.value || null,
    open_threads: openThreads.length ? openThreads : null,
    last_world_event_at: content.querySelector("#snap_ws_event_at")?.value || null,
  };
  const payload = {
    profile,
    worldState,
    lifeArcs: (() => {
      const arcs = [];
      content.querySelectorAll(".la-card").forEach(card => {
        const i = card.dataset.index;
        arcs.push({
          id: content.querySelector(`#la_${i}_id`)?.value || "",
          title: content.querySelector(`#la_${i}_title`)?.value || "",
          kind: content.querySelector(`#la_${i}_kind`)?.value || "",
          status: content.querySelector(`#la_${i}_status`)?.value || "active",
          summary: content.querySelector(`#la_${i}_summary`)?.value || "",
          currentState: content.querySelector(`#la_${i}_state`)?.value || "",
          nextUsefulMoment: content.querySelector(`#la_${i}_next`)?.value || "",
          timeStart: content.querySelector(`#la_${i}_ts`)?.value || null,
          timeEnd: content.querySelector(`#la_${i}_te`)?.value || null,
          expiresAt: content.querySelector(`#la_${i}_exp`)?.value || null,
        });
      });
      return arcs;
    })(),
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
  // Number inputs: auto-save on change with debounce
  const debouncedSaveNum = debounce(async (el) => {
    const key = el.dataset.key;
    if (!key) return;
    let val = Number(el.value);
    if (el.dataset.ms === 'h') val = fromH(val);
    else if (el.dataset.ms === 'd') val = fromD(val);
    else if (el.dataset.ms === '1') val = fromS(val);
    await savePromptField(key, val, true);
  }, 300);

  content.querySelectorAll('.prompts-editable').forEach(el => {
    if (el.classList.contains('prompts-num')) {
      el.addEventListener('change', () => debouncedSaveNum(el));
    } else if (el.tagName === 'TEXTAREA' && !el.classList.contains('prompts-textarea')) {
      const debouncedSaveArr = debounce(async (ta) => {
        const key = ta.dataset.key;
        if (!key) return;
        const lines = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
        await savePromptField(key, lines, true);
      }, 300);
      el.addEventListener('change', () => debouncedSaveArr(el));
    }
  });
  content.querySelectorAll('[data-action="edit-text"]').forEach(btn => {
    btn.addEventListener("click", () => { promptsEditing[btn.dataset.key] = true; afterSave(); });
  });
  content.querySelectorAll('[data-action="cancel-text"]').forEach(btn => {
    btn.addEventListener("click", () => {
      promptsEditing[btn.dataset.key] = false;
      afterSave();
    });
  });
  content.querySelectorAll('[data-action="save-text"]').forEach(btn => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.key;
      const el = content.querySelector(`#prompt_${key}`);
      const val = el ? el.value : '';
      promptsEditing[key] = false;
      await savePromptField(key, val);
      afterSave();
    });
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

function renderPagination(total, page, totalPages, prefix = "history", label = "messages") {
  if (totalPages <= 1) return "";
  const pages = [];
  const maxButtons = 7;
  let start = Math.max(1, page - 3);
  let end = Math.min(totalPages, start + maxButtons - 1);
  if (end - start < maxButtons - 1) start = Math.max(1, end - maxButtons + 1);

  const attr = `data-${prefix}-page`;
  if (page > 1) pages.push(`<button class="page-btn" ${attr}="${page - 1}" title="Previous">Prev</button>`);
  if (start > 1) {
    pages.push(`<button class="page-btn" ${attr}="1">1</button>`);
    if (start > 2) pages.push(`<span class="page-ellipsis">...</span>`);
  }
  for (let i = start; i <= end; i++) {
    pages.push(`<button class="page-btn${i === page ? " active" : ""}" ${attr}="${i}">${i}</button>`);
  }
  if (end < totalPages) {
    if (end < totalPages - 1) pages.push(`<span class="page-ellipsis">...</span>`);
    pages.push(`<button class="page-btn" ${attr}="${totalPages}">${totalPages}</button>`);
  }
  if (page < totalPages) pages.push(`<button class="page-btn" ${attr}="${page + 1}" title="Next">Next</button>`);
  pages.push(`<span class="page-jump"><input id="${prefix}PageJumpInput" type="number" min="1" max="${totalPages}" value="${page}" data-total-pages="${totalPages}" title="Jump to page"><button id="${prefix}PageJumpBtn" class="page-btn" title="Go">Go</button></span>`);

  return `<div class="pagination"><span class="page-info">${total} ${label}</span><div class="page-btns">${pages.join("")}</div></div>`;
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

function formatTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = n => String(n).padStart(2, "0");
    const bj = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
    return `${bj.getFullYear()}-${pad(bj.getMonth()+1)}-${pad(bj.getDate())} ${pad(bj.getHours())}:${pad(bj.getMinutes())}`;
  } catch { return iso; }
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
        <div class="memory-toolbar">
          <select id="proactiveProfileSelect">
            ${profiles.map(name => `<option value="${escAttr(name)}"${name === proactiveState.profile ? " selected" : ""}>${escHtml(name)}</option>`).join("")}
          </select>
        </div>
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
  const activeArcs = lifeArcs.filter(a => a.status !== "closed");
  const closedArcs = lifeArcs.filter(a => a.status === "closed");
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
  const candidates = session.scheduleCandidates || [];
  const candidatesHtml = candidates.length ? `
    <details class="proactive-group">
      <summary class="proactive-group-summary">
        <span class="proactive-group-dot candidate"></span>
        <span class="proactive-group-label">Candidates</span>
        <span class="proactive-group-count">${candidates.length}</span>
      </summary>
      <div class="proactive-group-body">
        ${renderScheduleCandidatesList(candidates)}
      </div>
    </details>
  ` : "";
  const closedHtml = closedArcs.length ? `
    <details class="proactive-group">
      <summary class="proactive-group-summary">
        <span class="proactive-group-dot closed"></span>
        <span class="proactive-group-label">Closed</span>
        <span class="proactive-group-count">${closedArcs.length}</span>
      </summary>
      <div class="proactive-group-body">
        ${renderLifeArcList(closedArcs, now)}
      </div>
    </details>
  ` : "";
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
      ${activeArcs.length ? renderLifeArcList(activeArcs, now) : ""}
      ${candidatesHtml}
      ${closedHtml}
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

function renderScheduleCandidatesList(candidates) {
  return `
    <div class="schedule-candidates-list">
      ${candidates.map(c => `
        <div class="schedule-candidate-item">
          <div class="schedule-candidate-title">${escHtml(c.title || "(untitled)")}</div>
          <div class="schedule-candidate-summary">${escHtml(c.summary || "")}</div>
          <div class="schedule-candidate-meta">
            ${c.kind ? `<span class="tag">${escHtml(c.kind)}</span>` : ""}
            ${c.subject ? `<span class="tag">${escHtml(c.subject)}</span>` : ""}
            ${c.timeStart ? `<span>start: ${escHtml(c.timeStart)}</span>` : ""}
            ${c.timeEnd ? `<span>end: ${escHtml(c.timeEnd)}</span>` : ""}
          </div>
          ${c.basis ? `<div class="schedule-candidate-basis">${escHtml(c.basis)}</div>` : ""}
        </div>
      `).join("")}
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
let memoryState = { role: "", category: "", editingId: null, renameUid: null, allEntries: [], allUsers: [], page: 1 };
const MEM_PAGE_SIZE = 12;

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
  const totalPages = Math.ceil(filtered.length / MEM_PAGE_SIZE) || 1;
  if (memoryState.page > totalPages) memoryState.page = totalPages;
  const start = (memoryState.page - 1) * MEM_PAGE_SIZE;
  const paged = filtered.slice(start, start + MEM_PAGE_SIZE);
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
      ${renderMemoryCards(paged)}
      ${renderPagination(filtered.length, memoryState.page, totalPages, "mem")}
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
  let html = '<div class="memory-section-cards">';
  for (const item of entries) {
    html += renderMemoryCard(item);
  }
  html += '</div>';
  return html;
}

function renderMemoryCard(item) {
  const isEditing = memoryState.editingId === item.id;
  if (isEditing) return renderMemoryCardEdit(item);

  return `
    <div class="memory-card" data-mem-id="${escAttr(item.id)}">
      <div class="memory-card-top">
        <span class="memory-card-category ${item.category}">${CAT_LABELS[item.category] || item.category}</span>
        <span class="memory-card-role">${escHtml(item.role || "")}</span>
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
    memoryState.page = 1;
    renderMemory();
  });

  content.querySelectorAll(".memory-filter-chip").forEach(btn => {
    btn.addEventListener("click", () => {
      memoryState.category = btn.dataset.cat;
      memoryState.editingId = null;
      memoryState.renameUid = null;
      memoryState.page = 1;
      renderMemory();
    });
  });

  // Memory pagination
  content.querySelectorAll('[data-mem-page]').forEach(btn => {
    btn.addEventListener("click", () => {
      memoryState.page = Number(btn.dataset.memPage);
      renderMemory();
    });
  });
  const memJumpInput = content.querySelector("#memPageJumpInput");
  const memJumpBtn = content.querySelector("#memPageJumpBtn");
  if (memJumpInput && memJumpBtn) {
    memJumpBtn.addEventListener("click", () => {
      const p = Number(memJumpInput.value);
      const max = Number(memJumpInput.dataset.totalPages) || 1;
      if (p >= 1 && p <= max) { memoryState.page = p; renderMemory(); }
    });
    memJumpInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); memJumpBtn.click(); }
    });
  }

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
    S("Models", F("models.claudeFast", "Claude Fast Model", c.models?.claudeFast) + F("models.claudeFallback", "Claude Fallback Model", c.models?.claudeFallback)),
    S("Timeouts", F("timeouts.aiMs", "AI Timeout (ms)", c.timeouts?.aiMs, "number")),
    S("Vision", Select("vision.mode", "Mode", c.vision?.mode || "auto", [["auto", "Auto"], ["external", "External API"], ["native", "Native backend"], ["off", "Off"]]) + F("vision.baseUrl", "API Base URL", c.vision?.baseUrl, "text", "Default SiliconFlow") + F("vision.apiKey", "API Key", c.vision?.apiKey, "password", "Only for External API") + F("vision.model", "Model Name", c.vision?.model, "text", "Default Qwen/Qwen3-VL-32B-Instruct") + F("vision.detail", "Detail Level", c.vision?.detail) + F("vision.timeoutMs", "Timeout (ms)", c.vision?.timeoutMs, "number")),
    S("RAG", F("rag.knowledgeDir", "Knowledge Directory", c.rag?.knowledgeDir) + F("rag.collectionName", "Collection Name", c.rag?.collectionName) + F("rag.embedModel", "Embedding Model", c.rag?.embedModel) + F("rag.storeDir", "Vector Store Dir", c.rag?.storeDir) + F("rag.modelCacheDir", "Model Cache Dir", c.rag?.modelCacheDir) + F("rag.scoreMargin", "Score Margin", c.rag?.scoreMargin, "number") + F("rag.chunkMaxChars", "Chunk Max Chars", c.rag?.chunkMaxChars, "number") + F("rag.batchSize", "Batch Size", c.rag?.batchSize, "number") + F("rag.enabled", "Enabled (true/false)", c.rag?.enabled)),
    S("Send", F("send.chunkSendDelayMs", "Chunk Send Delay (ms)", c.send?.chunkSendDelayMs, "number") + F("send.maxCancelReasonLength", "Max Cancel Reason Length", c.send?.maxCancelReasonLength, "number")),
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
    else if (["aiMs", "timeoutMs", "topK", "minScore", "scoreMargin", "chunkMaxChars", "resultMaxChars", "batchSize", "retentionDays", "chunkSendDelayMs", "maxCancelReasonLength"].includes(last)) cur[last] = Number(val);
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
