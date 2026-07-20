import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";
import { backfillUsedRagFromLogs } from "../lib/chat-history.mjs";

const appJs = readFileSync(join(import.meta.dirname, "..", "static", "app.js"), "utf-8");
const chatHistory = readFileSync(join(import.meta.dirname, "..", "lib", "chat-history.mjs"), "utf-8");
const guiHistory = readFileSync(join(import.meta.dirname, "..", "lib", "gui-history.mjs"), "utf-8");
const guiWorld = readFileSync(join(import.meta.dirname, "..", "lib", "gui-world.mjs"), "utf-8");
const worldlineArchive = readFileSync(join(import.meta.dirname, "..", "lib", "worldline-archive.mjs"), "utf-8");
const botSource = readFileSync(join(import.meta.dirname, "..", "bot.mjs"), "utf-8");

describe("History tool usage UI", () => {
  it("renders a small missing-scenelet note for assistant messages", () => {
    assert.match(appJs, /function renderHistorySceneletNote/);
    assert.match(appJs, /Scenelet: missing/);
    assert.match(appJs, /renderHistorySceneletNote\(item\)/);
    assert.match(chatHistory, /sceneletStatus: event\.sceneletStatus/);
    assert.match(chatHistory, /sceneletError: event\.sceneletError/);
  });

  it("allows local SQLite history edits for every backend without showing an extra edit note", () => {
    assert.doesNotMatch(appJs, /Editing here changes the local SQLite visible history/);
    assert.doesNotMatch(appJs, /history-note/);
    assert.match(appJs, /const backendCanEdit = \(\) => true/);
    assert.match(guiHistory, /SQLite history is the project-visible history used for visible context/);
    assert.doesNotMatch(guiHistory, /activeAI !== "api"/);
  });

  it("renders a small WebSearch note for assistant messages", () => {
    assert.match(appJs, /function renderHistoryToolNote/);
    assert.match(appJs, /WebSearch: not recorded/);
    assert.match(appJs, /WebSearch: \$\{searched \? "yes" : "no"\}/);
    assert.match(appJs, /RAG: not recorded/);
    assert.match(appJs, /RAG: \$\{rag\.used \? "yes" : "no"\}/);
    assert.match(appJs, /renderHistoryToolNote\(item\)/);
  });

  it("keeps archived worldlines visible but separate from active history", () => {
    assert.match(appJs, /Archived Worldlines/);
    assert.match(appJs, /historyState = \{ q: "", source: "active"/);
    assert.match(appJs, /data-history-source="archive"/);
    assert.match(appJs, /source === "archive"/);
    assert.match(appJs, /<span class="history-kind">archived<\/span>/);
    assert.match(guiHistory, /archivedConversations: listArchivedConversations/);
    assert.match(guiHistory, /source === "archive"/);
    assert.match(guiHistory, /listArchivedMessages/);
  });

  it("exposes archive and hard reset controls without mixing them into normal edit flow", () => {
    assert.match(appJs, /Archive \+ Hard Reset/);
    assert.match(appJs, /\/api\/worldline\/archive-reset/);
    assert.match(guiWorld, /\/api\/worldline\/archive/);
    assert.match(guiWorld, /\/api\/worldline\/archive-reset/);
    assert.match(worldlineArchive, /production-snapshot/);
    assert.match(worldlineArchive, /runtime-state/);
    assert.match(worldlineArchive, /extracted/);
    assert.match(worldlineArchive, /restore/);
    assert.match(worldlineArchive, /MANIFEST\.json/);
    assert.match(worldlineArchive, /deleteEventsForProfiles/);
    assert.match(worldlineArchive, /resetRoleRuntimeWorld/);
  });

  it("persists tool usage metadata in chat history", () => {
    assert.match(chatHistory, /function normalizeToolUsage/);
    assert.match(chatHistory, /function normalizeRagUsage/);
    assert.match(chatHistory, /toolUsage: normalizeToolUsage\(event\.toolUsage\)/);
    assert.match(chatHistory, /ragUsage: normalizeRagUsage\(event\.ragUsage\)/);
  });

  it("passes RAG usage from execution into assistant history", () => {
    assert.match(botSource, /ragUsage = \{ eligible: ragEligible, used: Boolean\(ragContext\), chars: String\(ragContext \|\| ""\)\.length \}/);
    assert.match(botSource, /toolUsage, ragUsage, timestamp: assistantAt/);
    assert.match(chatHistory, /function backfillUsedRagFromLogs/);
    assert.match(chatHistory, /backfillUsedRagFromLogs\(_db\)/);
  });

  it("backfills a legacy positive RAG hit from the matching run log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "history-rag-"));
    try {
      writeFileSync(join(dir, "cst-cc.jsonl"), JSON.stringify({
        ts: "2026-06-12T05:31:54.165Z",
        ai: "cc",
        userId: "u1",
        sessionName: "cst",
        bodyChars: 2,
        ragChars: 1007,
      }) + "\n");
      const SQL = await initSqlJs();
      const db = new SQL.Database();
      db.run("CREATE TABLE events (id TEXT, timestamp TEXT, userId TEXT, ai TEXT, sessionName TEXT, role TEXT, kind TEXT, text TEXT, ragUsage TEXT)");
      const timestamp = "2026-06-12T05:32:12.335Z";
      db.run("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)", ["u", timestamp, "u1", "cc", "cst", "user", "chat", "你好", "{}"]);
      db.run("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)", ["a", timestamp, "u1", "cc", "cst", "assistant", "chat", "回复", "{}"]);

      assert.equal(backfillUsedRagFromLogs(db, dir), 1);
      const value = db.exec("SELECT ragUsage FROM events WHERE id='a'")[0].values[0][0];
      assert.deepEqual(JSON.parse(value), { eligible: true, used: true, chars: 1007 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
