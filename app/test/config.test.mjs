import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { configValue, envOrConfig, configBool, configNumber } from "../lib/config.mjs";

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
