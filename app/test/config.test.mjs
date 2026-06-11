import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { configValue, envOrConfig, configBool, configNumber } from "../lib/config.mjs";
import { maskConfigSecrets, sanitizeConfigBody } from "../lib/gui-config.mjs";

describe("configValue", () => {
  it("returns fallback for missing key", () => {
    assert.equal(configValue("nonexistent.key", 42), 42);
  });
});

describe("configBool", () => {
  it("returns default for missing key", () => {
    assert.equal(configBool("nonexistent.key", true), true);
    assert.equal(configBool("nonexistent.key", false), false);
  });
});

describe("configNumber", () => {
  it("returns fallback for missing key", () => {
    assert.equal(configNumber("nonexistent.key", 100), 100);
  });
});

describe("envOrConfig", () => {
  it("returns config value without env override", () => {
    // Without env set, falls back to configValue → fallback
    delete process.env.TEST_NONEXISTENT;
    const r = envOrConfig("TEST_NONEXISTENT", "nonexistent.key", "default");
    assert.equal(r, "default");
  });
});

describe("GUI API config", () => {
  it("persists Direct API fields", () => {
    const current = { api: { baseUrl: "", apiKey: "old-secret", model: "old-model" } };
    const next = sanitizeConfigBody({
      api: { baseUrl: "https://example.test", apiKey: "new-secret", model: "new-model" },
    }, current);
    assert.deepEqual(next.api, {
      baseUrl: "https://example.test",
      apiKey: "new-secret",
      model: "new-model",
    });
  });

  it("preserves masked API keys and masks secrets for display", () => {
    const current = {
      api: { apiKey: "api-secret-value" },
      vision: { apiKey: "vision-secret-value" },
    };
    const next = sanitizeConfigBody({
      api: { apiKey: "api-secr****" },
      vision: { apiKey: "vision-s****" },
    }, current);
    assert.equal(next.api.apiKey, current.api.apiKey);
    assert.equal(next.vision.apiKey, current.vision.apiKey);

    const masked = maskConfigSecrets(current);
    assert.equal(masked.api.apiKey, "api-secr****");
    assert.equal(masked.vision.apiKey, "vision-s****");
    assert.equal(current.api.apiKey, "api-secret-value");
  });
});
