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
      case "sessions": await renderSessions(); break;
      case "profiles": await renderProfiles(); break;
      case "config": await renderConfig(); break;
    }
  } catch (e) {
    content.innerHTML = `<div class="panel"><p class="error-text">Error: ${escHtml(e.message)}</p></div>`;
  }
}

// Status
async function renderStatus() {
  const s = await get("/api/status");
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
  `;
}

// Sessions
async function renderSessions() {
  const d = await get("/api/sessions");
  const rows = d.sessions.map(s => `
    <tr>
      <td><span class="badge badge-${s.ai === 'cc' ? 'cc' : 'codex'}">${s.ai === 'cc' ? 'CC' : 'Codex'}</span></td>
      <td>${s.active ? '<strong class="active-mark">→</strong>' : ''} ${escHtml(s.name)}</td>
      <td><span class="badge badge-default">${escHtml(s.profile)}</span></td>
      <td>${s.busy ? 'Busy' : s.queue ? 'Queue(' + Number(s.queue) + ')' : 'Idle'}</td>
    </tr>
  `).join("");

  const resume = await get("/api/sessions/resume");
  const resumeCommands = resumeCommandList(resume);
  content.innerHTML = `
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

// Profiles
async function renderProfiles() {
  const d = await get("/api/profiles");
  const rows = d.profiles.map(p => `
    <tr>
      <td class="profile-name"><strong>${escHtml(p.name)}</strong></td>
      <td class="prompt-preview">${escHtml(p.prompt.slice(0, 110))}${p.prompt.length > 110 ? '...' : ''}</td>
      <td>${Number(p.bindings)} session${p.bindings !== 1 ? 's' : ''}</td>
      <td class="actions-cell">
        <button class="btn" data-action="edit-profile" data-profile="${escAttr(p.name)}">Edit</button>
        ${p.name !== '默认' ? `<button class="btn btn-danger" data-action="delete-profile" data-profile="${escAttr(p.name)}">Del</button>` : ''}
      </td>
    </tr>
  `).join("");

  content.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Profiles</h2>
        <button class="btn btn-primary" onclick="showAddProfile()">+ Add</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Prompt</th><th>Bindings</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div id="profileForm" class="mt"></div>
    </div>
  `;
  content.querySelectorAll('[data-action="edit-profile"]').forEach(btn => {
    btn.addEventListener("click", () => editProfile(btn.dataset.profile));
  });
  content.querySelectorAll('[data-action="delete-profile"]').forEach(btn => {
    btn.addEventListener("click", () => deleteProfile(btn.dataset.profile));
  });
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
    S("Proxy", F("proxy.https", "HTTPS Proxy", c.proxy?.https, "text", "Optional")),
    S("Models", F("models.claudeFast", "Claude Fast Model", c.models?.claudeFast) + F("models.claudeFallback", "Claude Fallback Model", c.models?.claudeFallback)),
    S("Timeouts", F("timeouts.aiMs", "AI Timeout (ms)", c.timeouts?.aiMs, "number")),
    S("Vision", Select("vision.mode", "Mode", c.vision?.mode || "auto", [["auto", "Auto"], ["external", "External API"], ["native", "Native backend"], ["off", "Off"]]) + F("vision.baseUrl", "API Base URL", c.vision?.baseUrl, "text", "Default SiliconFlow") + F("vision.apiKey", "API Key", c.vision?.apiKey, "password", "Only for External API") + F("vision.model", "Model Name", c.vision?.model, "text", "Default Qwen/Qwen3-VL-32B-Instruct") + F("vision.detail", "Detail Level", c.vision?.detail) + F("vision.timeoutMs", "Timeout (ms)", c.vision?.timeoutMs, "number")),
    S("RAG", F("rag.knowledgeDir", "Knowledge Directory", c.rag?.knowledgeDir) + F("rag.collectionName", "Collection Name", c.rag?.collectionName) + F("rag.embedModel", "Embedding Model", c.rag?.embedModel) + F("rag.storeDir", "Vector Store Dir", c.rag?.storeDir) + F("rag.modelCacheDir", "Model Cache Dir", c.rag?.modelCacheDir) + F("rag.topK", "Top K Results", c.rag?.topK, "number") + F("rag.minScore", "Min Score", c.rag?.minScore, "number") + F("rag.scoreMargin", "Score Margin", c.rag?.scoreMargin, "number") + F("rag.chunkMaxChars", "Chunk Max Chars", c.rag?.chunkMaxChars, "number") + F("rag.resultMaxChars", "Result Max Chars", c.rag?.resultMaxChars, "number") + F("rag.batchSize", "Batch Size", c.rag?.batchSize, "number") + F("rag.enabled", "Enabled (true/false)", c.rag?.enabled)),
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

setInterval(() => { document.getElementById("clock").textContent = new Date().toLocaleString("zh-CN"); }, 1000);
render();
