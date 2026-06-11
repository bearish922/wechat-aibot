import test from "node:test";
import assert from "node:assert/strict";
import { InputBatcher, messageHasBatchableMedia } from "../lib/input-batcher.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeBatcher(delayMs = 15) {
  const pendingInputs = new Map();
  const flushed = [];
  const batcher = new InputBatcher({
    pendingInputs,
    delayMs,
    onFlush: (messageAI, userId, body, ctx) => flushed.push({ messageAI, userId, body, ctx }),
  });
  return { batcher, pendingInputs, flushed };
}

test("detects media before asynchronous extraction starts", () => {
  assert.equal(messageHasBatchableMedia({ item_list: [{ type: 2 }] }), true);
  assert.equal(messageHasBatchableMedia({ item_list: [{ type: 1 }] }), false);
});

test("merges slow media and later text once in arrival order", async () => {
  const { batcher, flushed } = makeBatcher();
  const mediaOrder = batcher.nextOrder();
  const mediaRef = batcher.reserveMedia({
    userId: "u1",
    messageAI: "cc",
    ctx: { context_token: "image" },
    order: mediaOrder,
  });

  batcher.appendText({
    userId: "u1",
    messageAI: "cc",
    body: "first text",
    ctx: { context_token: "text-1" },
    order: batcher.nextOrder(),
  });
  batcher.appendText({
    userId: "u1",
    messageAI: "cc",
    body: "second text",
    ctx: { context_token: "text-2" },
    order: batcher.nextOrder(),
  });
  batcher.completeMedia(mediaRef, { body: "[image]", ctx: { context_token: "image" } });

  await sleep(35);
  assert.deepEqual(flushed, [{
    messageAI: "cc",
    userId: "u1",
    body: "[image]\nfirst text\nsecond text",
    ctx: { context_token: "text-2" },
  }]);
});

test("waits for unresolved media after the quiet window", async () => {
  const { batcher, flushed } = makeBatcher(10);
  const mediaRef = batcher.reserveMedia({
    userId: "u2",
    messageAI: "cc",
    ctx: { context_token: "image" },
    order: batcher.nextOrder(),
  });

  await sleep(25);
  assert.equal(flushed.length, 0);
  batcher.completeMedia(mediaRef, { body: "[slow image]", ctx: { context_token: "image" } });
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].body, "[slow image]");
});

test("cancel prevents late media completion from reviving a batch", async () => {
  const { batcher, pendingInputs, flushed } = makeBatcher(10);
  const mediaRef = batcher.reserveMedia({
    userId: "u3",
    messageAI: "cc",
    ctx: { context_token: "image" },
    order: batcher.nextOrder(),
  });

  assert.equal(batcher.cancel("u3"), true);
  assert.equal(pendingInputs.has("u3"), false);
  assert.equal(batcher.completeMedia(mediaRef, { body: "[late image]", ctx: {} }), false);
  await sleep(20);
  assert.equal(flushed.length, 0);
});

test("explicit flush waits for media extraction and enqueues once", async () => {
  const { batcher, flushed } = makeBatcher(50);
  const mediaRef = batcher.reserveMedia({
    userId: "u4",
    messageAI: "cc",
    ctx: { context_token: "image" },
    order: batcher.nextOrder(),
  });
  const completion = batcher.flush("u4");

  assert.equal(flushed.length, 0);
  batcher.completeMedia(mediaRef, { body: "[image]", ctx: { context_token: "image" } });
  assert.equal(await completion, true);
  assert.equal(flushed.length, 1);
});
