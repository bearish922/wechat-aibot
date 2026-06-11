const MEDIA_ITEM_TYPES = new Set([2, 3, 4, 5]);

export function messageHasBatchableMedia(msg) {
  return (msg?.item_list || []).some(item => MEDIA_ITEM_TYPES.has(item?.type));
}

function joinReadyItems(items) {
  const ready = items
    .filter(item => item.ready && item.body?.trim())
    .sort((a, b) => a.order - b.order);
  let body = "";
  for (const item of ready) {
    if (!body) body = item.body.trim();
    else body += `${item.kind === "media" ? "\n---\n" : "\n"}${item.body.trim()}`;
  }
  return body;
}

export class InputBatcher {
  constructor({ pendingInputs, delayMs, onFlush }) {
    this.pendingInputs = pendingInputs;
    this.delayMs = delayMs;
    this.onFlush = onFlush;
    this.arrivalOrder = 0;
  }

  nextOrder() {
    this.arrivalOrder += 1;
    return this.arrivalOrder;
  }

  reserveMedia({ userId, messageAI, ctx, order }) {
    let batch = this.pendingInputs.get(userId);
    if (batch && batch.messageAI !== messageAI) return null;
    if (!batch) batch = this.#createBatch({ userId, messageAI, ctx, order });

    const item = { kind: "media", order, body: "", ready: false };
    batch.items.push(item);
    batch.unresolved += 1;
    this.#updateContext(batch, ctx, order);
    this.#schedule(batch);
    return { batch, item };
  }

  completeMedia(ref, { body, ctx }) {
    if (!ref?.batch || ref.item.ready) return false;
    const { batch, item } = ref;
    if (batch.cancelled || this.pendingInputs.get(batch.userId) !== batch) return false;

    item.body = body || "";
    item.ready = true;
    batch.unresolved = Math.max(0, batch.unresolved - 1);
    this.#updateContext(batch, ctx, item.order);
    this.#maybeFlush(batch);
    return true;
  }

  appendText({ userId, messageAI, body, ctx, order }) {
    const batch = this.pendingInputs.get(userId);
    if (!batch || batch.messageAI !== messageAI || batch.cancelled) return false;

    batch.items.push({ kind: "text", order, body, ready: true });
    this.#updateContext(batch, ctx, order);
    this.#schedule(batch);
    return true;
  }

  flush(userId) {
    const batch = this.pendingInputs.get(userId);
    if (!batch) return Promise.resolve(false);
    clearTimeout(batch.timer);
    batch.timer = null;
    batch.quietElapsed = true;
    this.#maybeFlush(batch);
    return batch.completion;
  }

  cancel(userId) {
    const batch = this.pendingInputs.get(userId);
    if (!batch) return false;
    return batch.cancel();
  }

  #createBatch({ userId, messageAI, ctx, order }) {
    let resolveCompletion;
    const completion = new Promise(resolve => { resolveCompletion = resolve; });
    const batch = {
      kind: "media-input-batch",
      userId,
      messageAI,
      ctx,
      ctxOrder: order,
      items: [],
      unresolved: 0,
      quietElapsed: false,
      timer: null,
      cancelled: false,
      completion,
      resolveCompletion,
      cancel: () => {
        if (batch.cancelled || this.pendingInputs.get(userId) !== batch) return false;
        batch.cancelled = true;
        clearTimeout(batch.timer);
        batch.timer = null;
        this.pendingInputs.delete(userId);
        batch.resolveCompletion(false);
        return true;
      },
    };
    this.pendingInputs.set(userId, batch);
    return batch;
  }

  #updateContext(batch, ctx, order) {
    if (order < batch.ctxOrder) return;
    batch.ctx = ctx;
    batch.ctxOrder = order;
  }

  #schedule(batch) {
    clearTimeout(batch.timer);
    batch.quietElapsed = false;
    batch.timer = setTimeout(() => {
      if (batch.cancelled || this.pendingInputs.get(batch.userId) !== batch) return;
      batch.timer = null;
      batch.quietElapsed = true;
      this.#maybeFlush(batch);
    }, this.delayMs);
  }

  #maybeFlush(batch) {
    if (batch.cancelled || !batch.quietElapsed || batch.unresolved > 0) return false;
    if (this.pendingInputs.get(batch.userId) !== batch) return false;

    const body = joinReadyItems(batch.items);
    this.pendingInputs.delete(batch.userId);
    clearTimeout(batch.timer);
    batch.timer = null;
    try {
      if (body) this.onFlush(batch.messageAI, batch.userId, body, batch.ctx);
      batch.resolveCompletion(Boolean(body));
    } catch (error) {
      batch.resolveCompletion(false);
      throw error;
    }
    return true;
  }
}
