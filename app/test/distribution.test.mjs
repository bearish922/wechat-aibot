import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const appPackage = JSON.parse(readFileSync(join(root, "app", "package.json"), "utf-8"));
const release = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf-8");
const setup = readFileSync(join(root, "scripts", "setup.bat"), "ascii");
const gitignore = readFileSync(join(root, ".gitignore"), "utf-8");

describe("installation and release layout", () => {
  it("installs chat history dependencies from the app package", () => {
    assert.ok(appPackage.dependencies?.["sql.js"]);
    assert.match(setup, /npm --prefix app install/);
    assert.equal(existsSync(join(root, "package.json")), false);
    assert.equal(existsSync(join(root, "package-lock.json")), false);
  });

  it("packages current data templates", () => {
    assert.match(release, /data\/wechat-profiles\.json/);
    assert.match(release, /data\/wechat-memory\.example\.json/);
    assert.match(release, /data\/prompts\.json/);
    assert.doesNotMatch(release, /launch\.bat wechat-profiles\.json/);
  });

  it("ignores dependency folders at both package locations", () => {
    assert.match(gitignore, /^app\/node_modules\/$/m);
    assert.match(gitignore, /^node_modules\/$/m);
  });
});
