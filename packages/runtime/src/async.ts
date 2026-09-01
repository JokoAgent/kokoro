export class AsyncSignal {
  #waiters = new Set<() => void>();
  #signaled = false;

  notify(): void {
    const waiters = [...this.#waiters];
    if (waiters.length === 0) {
      this.#signaled = true;
      return;
    }
    this.#waiters.clear();
    for (const resolve of waiters) resolve();
  }

  wait(signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#signaled) {
      this.#signaled = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        this.#waiters.delete(done);
        resolve();
      };
      const aborted = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        this.#waiters.delete(done);
        reject(signal?.reason ?? new Error("Operation aborted."));
      };
      this.#waiters.add(done);
      signal?.addEventListener("abort", aborted, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(done, Math.max(0, timeoutMs));
    });
  }
}

export class AsyncMutex {
  #tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function abortError(message = "Operation aborted."): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
