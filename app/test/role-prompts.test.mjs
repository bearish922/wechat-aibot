import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getGenericRolePromptDefaults, mergeRolePrompts, ROLE_PROMPT_FIELDS } from "../lib/role-prompts.mjs";
import { loadPromptDocument, loadPrompts } from "../lib/reply.mjs";
import * as globalDefaults from "../lib/default-prompts.mjs";

describe("Role prompt suites", () => {
  it("isolates role text while shared runtime settings stay global", () => {
    const document = {
      visibleContextTurns: 12,
      ragKeywords: { lore: ["shared"], names: [] },
      roles: {
        A: { chatStyle: "style-a", sceneletInstructions: "scene-a" },
        B: { chatStyle: "style-b", sceneletInstructions: "scene-b" },
      },
    };

    assert.equal(mergeRolePrompts(document, "A").chatStyle, "style-a");
    assert.equal(mergeRolePrompts(document, "B").chatStyle, "style-b");
    assert.notEqual(mergeRolePrompts(document, "A").sceneletInstructions, mergeRolePrompts(document, "B").sceneletInstructions);
  });

  it("keeps legacy flat prompt documents readable before migration", () => {
    const legacy = { chatStyle: "legacy-style", sceneletInstructions: "legacy-scene" };
    assert.equal(mergeRolePrompts(legacy, "any-role").chatStyle, "legacy-style");
    assert.equal(mergeRolePrompts(legacy, "any-role").sceneletInstructions, "legacy-scene");
  });

  it("migrates the current tuned suite to Chisato without leaking it to new roles", () => {
    const document = loadPromptDocument();
    assert.equal(document.version, 2);
    assert.deepEqual(Object.keys(document.roles), ["白鹭千圣"]);
    assert.equal(Object.keys(document.roles["白鹭千圣"]).length, ROLE_PROMPT_FIELDS.length);

    const chisato = loadPrompts("白鹭千圣");
    const untuned = loadPrompts("新角色");
    assert.notEqual(chisato.chatStyle, untuned.chatStyle);
    assert.match(chisato.sceneletReplyBridgeInstruction, /千圣/);
    assert.doesNotMatch(untuned.sceneletReplyBridgeInstruction, /千圣|小彩|PasPale|Leo/);
    assert.deepEqual(chisato.ragKeywords, untuned.ragKeywords);
  });

  it("provides a complete neutral baseline for every scoped field", () => {
    const generic = getGenericRolePromptDefaults();
    assert.deepEqual(Object.keys(generic).sort(), [...ROLE_PROMPT_FIELDS].sort());
    for (const key of ROLE_PROMPT_FIELDS) assert.equal(typeof generic[key], "string", `${key} should have a string baseline`);
  });

  it("keeps role prompt defaults out of the global defaults module", () => {
    for (const key of ROLE_PROMPT_FIELDS) {
      const exportName = `DEFAULT_${key.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}`;
      assert.equal(exportName in globalDefaults, false, `${exportName} should not be globally exported`);
    }
  });

  it("preserves an explicit empty role prompt without falling back to another role", () => {
    const document = { roles: { A: { scheduleSpecialDates: "" } } };
    assert.equal(mergeRolePrompts(document, "A").scheduleSpecialDates, "");
  });
});
