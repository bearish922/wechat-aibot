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
  content.innerHTML = '<div class="card"><p>Loading...</p></div>';
  try {
    switch (activeTab) {
      case "status": await renderStatus(); break;
      case "sessions": await renderSessions(); break;
      case "profiles": await renderProfiles(); break;
      case "config": await renderConfig(); break;
    }
  } catch (e) {
    content.innerHTML = `<div class="card"><p style="color:#dc2626">Error: ${e.message}</p></div>`;
  }
}

// ── Status ──
async function renderStatus() {
  const s = await get("/api/status");
  content.innerHTML = `
    <div class="card">
      <h2>Status</h2>
      <p><span class="status-dot ${s.online ? 'online' : 'offline'}"></span>
      <strong>${s.online ? 'Online' : 'Offline'}</strong></p>
      <p>AI: <strong>${s.currentAI === 'cc' ? 'Claude Code' : 'Codex'}</strong> (${s.currentModel})</p>
      <p>Sessions: CC <strong>${s.sessions.cc}</strong> | Codex <strong>${s.sessions.codex}</strong></p>
    </div>
  `;
}

// ── Sessions ──
async function renderSessions() {
  const d = await get("/api/sessions");
  const rows = d.sessions.map(s => `
    <tr>
      <td><span class="badge badge-${s.ai}">${s.ai === 'cc' ? 'CC' : 'Codex'}</span></td>
      <td>${s.active ? '<strong>→</strong>' : ''} ${s.name}</td>
      <td><span class="badge badge-default">${s.profile}</span></td>
      <td>${s.busy ? 'Busy' : s.queue ? 'Queue(' + s.queue + ')' : 'Idle'}</td>
    </tr>
  `).join("");

  const resume = await get("/api/sessions/resume");
  content.innerHTML = `
    <div class="card">
      <h2>Sessions (${d.currentAI === 'cc' ? 'Claude Code' : 'Codex'})</h2>
      <table>${rows || '<tr><td colspan="4">No sessions</td></tr>'}</table>
    </div>
    <div class="card">
      <h2>Resume Commands</h2>
      <pre>${resume.text}</pre>
    </div>
  `;
}

// ── Profiles ──
async function renderProfiles() {
  const d = await get("/api/profiles");
  const rows = d.profiles.map(p => `
    <tr>
      <td><strong>${p.name}</strong></td>
      <td>${p.prompt.slice(0, 80)}${p.prompt.length > 80 ? '...' : ''}</td>
      <td>${p.bindings} session${p.bindings !== 1 ? 's' : ''}</td>
      <td>
        <button class="btn" onclick="editProfile('${escHtml(p.name)}')">Edit</button>
        ${p.name !== '默认' ? `<button class="btn btn-danger" onclick="deleteProfile('${escHtml(p.name)}')">Del</button>` : ''}
      </td>
    </tr>
  `).join("");

  content.innerHTML = `
    <div class="card">
      <div class="flex-between mb">
        <h2>Profiles</h2>
        <button class="btn btn-primary" onclick="showAddProfile()">+ Add</button>
      </div>
      <table>${rows}</table>
      <div id="profileForm" class="mt"></div>
    </div>
  `;
}

window.editProfile = async (name) => {
  const d = await get("/api/profiles");
  const p = d.profiles.find(x => x.name === name);
  if (!p) return;
  document.getElementById("profileForm").innerHTML = `
    <div class="card" style="margin-top:14px">
    <h3>Edit: ${name}</h3>
    <div class="form-group"><label>Prompt</label><textarea id="editPrompt">${escHtml(p.prompt)}</textarea></div>
    <button class="btn btn-primary" onclick="saveProfile('${escHtml(name)}')">Save</button>
    </div>
  `;
};

window.saveProfile = async (name) => {
  const prompt = document.getElementById("editPrompt").value;
  const r = await api("PUT", "/api/profiles", { name, prompt });
  toast(r.ok ? "Saved" : r.error, r.ok);
  if (r.ok) render();
};

window.showAddProfile = () => {
  document.getElementById("profileForm").innerHTML = `
    <div class="card" style="margin-top:14px">
    <h3>New Profile</h3>
    <div class="form-group"><label>Name</label><input id="newName"></div>
    <div class="form-group"><label>Prompt</label><textarea id="newPrompt"></textarea></div>
    <button class="btn btn-primary" onclick="addProfile()">Add</button>
    </div>
  `;
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

// ── Config ──
function F(key, label, value, type) {
  return `<div class="form-group"><label>${label}</label><input name="${key}" value="${escHtml(String(value ?? ''))}" type="${type || 'text'}"></div>`;
}
function S(title, body) { return `<h3>${title}</h3>${body}`; }

async function renderConfig() {
  const d = await get("/api/config");
  const c = d.config || {};

  const formHtml = [
    S("Paths", F("paths.claude", "Claude Code Path", c.paths?.claude) + F("paths.codex", "Codex Path", c.paths?.codex)),
    S("Proxy", F("proxy.https", "HTTPS Proxy", c.proxy?.https)),
    S("Models", F("models.claudeFast", "Claude Fast Model", c.models?.claudeFast) + F("models.claudeFallback", "Claude Fallback Model", c.models?.claudeFallback)),
    S("Timeouts", F("timeouts.aiMs", "AI Timeout (ms)", c.timeouts?.aiMs, "number")),
    S("Vision", F("vision.baseUrl", "API Base URL", c.vision?.baseUrl) + F("vision.apiKey", "API Key", c.vision?.apiKey, "password") + F("vision.model", "Model Name", c.vision?.model) + F("vision.detail", "Detail Level", c.vision?.detail) + F("vision.timeoutMs", "Timeout (ms)", c.vision?.timeoutMs, "number")),
    S("RAG", F("rag.knowledgeDir", "Knowledge Directory", c.rag?.knowledgeDir) + F("rag.collectionName", "Collection Name", c.rag?.collectionName) + F("rag.embedModel", "Embedding Model", c.rag?.embedModel) + F("rag.storeDir", "Vector Store Dir", c.rag?.storeDir) + F("rag.modelCacheDir", "Model Cache Dir", c.rag?.modelCacheDir) + F("rag.topK", "Top K Results", c.rag?.topK, "number") + F("rag.minScore", "Min Score", c.rag?.minScore, "number") + F("rag.scoreMargin", "Score Margin", c.rag?.scoreMargin, "number") + F("rag.chunkMaxChars", "Chunk Max Chars", c.rag?.chunkMaxChars, "number") + F("rag.resultMaxChars", "Result Max Chars", c.rag?.resultMaxChars, "number") + F("rag.batchSize", "Batch Size", c.rag?.batchSize, "number") + F("rag.enabled", "Enabled (true/false)", c.rag?.enabled)),
    S("Logs", F("logs.retentionDays", "Retention (days, 0=never)", c.logs?.retentionDays, "number")),
  ].join("");

  content.innerHTML = `
    <div class="card">
      <h2>Configuration</h2>
      <form id="configForm">${formHtml}<button type="submit" class="btn btn-primary mt">Save</button></form>
    </div>
  `;

  document.getElementById("configForm").addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const obj = buildNested(fd);
    const r = await post("/api/config", obj);
    toast(r.ok ? "Saved" : r.error, r.ok);
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

function escHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

setInterval(() => { document.getElementById("clock").textContent = new Date().toLocaleString("zh-CN"); }, 1000);
render();
