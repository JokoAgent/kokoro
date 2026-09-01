import { AsyncSignal } from "./async.js";
import type { JsonValue } from "./model.js";
import type { RuntimeFactStore } from "./store/index.js";

export interface RecordedToolCallback {
  callbackId: string;
  payload: JsonValue;
  receivedAt: number;
}

export class CallbackCoordinator {
  readonly #store: RuntimeFactStore;
  readonly #signals = new Map<string, AsyncSignal>();

  constructor(store: RuntimeFactStore) {
    this.#store = store;
  }

  notify(toolCallId: string): void {
    this.#signals.get(toolCallId)?.notify();
  }

  async wait(toolCallId: string, signal: AbortSignal): Promise<RecordedToolCallback> {
    for (;;) {
      const callback = this.#store.callbackForToolCall(toolCallId);
      if (callback) return callback;
      let waiter = this.#signals.get(toolCallId);
      if (!waiter) {
        waiter = new AsyncSignal();
        this.#signals.set(toolCallId, waiter);
      }
      try {
        await waiter.wait(signal);
      } finally {
        if (this.#signals.get(toolCallId) === waiter) this.#signals.delete(toolCallId);
      }
    }
  }
}
