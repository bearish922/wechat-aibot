import { loadAllEvents } from "../app/lib/chat-history.mjs";

const events = await loadAllEvents();
const keywords = [
  "AI", "ai", "模型", "算力", "coding", "应用", "产业", "基础设施", "物理AI", "机器人",
  "书", "小说", "作者", "濑户内", "寂听", "柠檬", "文学界", "短篇", "推荐",
  "电台", "广播", "节目", "radio",
  "歌曲", "歌名", "歌词", "きゅ", "flower", "応答", "OCR", "截图", "图片",
  "amita", "前岛", "前島",
];

const rows = [];
for (let i = 0; i < events.length; i += 1) {
  const event = events[i];
  if (event.role !== "user") continue;
  if (event.profile !== "白鹭千圣" && event.sessionName !== "cst") continue;
  const text = String(event.text || "");
  if (!keywords.some(k => text.includes(k))) continue;
  rows.push({
    index: i,
    timestamp: event.timestamp,
    profile: event.profile,
    sessionName: event.sessionName,
    text: text.replace(/\s+/g, " ").slice(0, 700),
  });
}

console.log(JSON.stringify({ count: rows.length, rows }, null, 2));
