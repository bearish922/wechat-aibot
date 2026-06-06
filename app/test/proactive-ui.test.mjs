import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appJs = readFileSync(join(import.meta.dirname, "..", "static", "app.js"), "utf-8");
const guiProactive = readFileSync(join(import.meta.dirname, "..", "lib", "gui-proactive.mjs"), "utf-8");

describe("Proactive life arcs UI", () => {
  it("uses the shared time formatter for life arc dates", () => {
    assert.doesNotMatch(appJs, /\bfmtTime\(/);
    assert.match(appJs, /formatTime\(arc\.timeStart\)/);
    assert.match(appJs, /formatTime\(arc\.timeEnd\)/);
    assert.match(appJs, /formatTime\(arc\.expiresAt\)/);
  });

  it("exposes schedule life arc fields from the API route", () => {
    for (const field of ["kind", "timeStart", "timeEnd"]) {
      assert.match(guiProactive, new RegExp(`${field}: a\\.${field}`));
    }
  });

  it("can filter proactive sessions by role/profile", () => {
    assert.match(appJs, /let proactiveState = \{ profile: "" \}/);
    assert.match(appJs, /proactiveProfileSelect/);
    assert.match(appJs, /allSessions\.filter\(s => \(s\.profile \|\| "default"\) === proactiveState\.profile\)/);
  });
});
