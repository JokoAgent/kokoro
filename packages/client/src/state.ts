import type { AuthoritySnapshot } from "@kokoro/protocol";
import { KokoroProtocolError, toError } from "./errors.js";

export type Unsubscribe = () => void;

export class AuthorityState {
  readonly #listeners = new Set<(snapshot: AuthoritySnapshot) => void>();
  readonly #onListenerError: ((error: Error) => void) | undefined;
  #snapshot: AuthoritySnapshot | undefined;
  #canonical: string | undefined;

  constructor(onListenerError?: (error: Error) => void) {
    this.#onListenerError = onListenerError;
  }

  get snapshot(): AuthoritySnapshot | undefined {
    return this.#snapshot;
  }

  /** Applies only monotonic server snapshots; equal revisions must be byte-for-fact equivalent. */
  apply(snapshot: AuthoritySnapshot): "advanced" | "same" | "stale" {
    const current = this.#snapshot;
    if (current && snapshot.revision < current.revision) return "stale";
    const canonical = JSON.stringify(snapshot);
    if (current?.revision === snapshot.revision) {
      if (canonical !== this.#canonical) {
        throw new KokoroProtocolError(
          `authority revision ${snapshot.revision} was reused for different facts`,
        );
      }
      return "same";
    }
    this.#snapshot = snapshot;
    this.#canonical = canonical;
    this.#notify(snapshot);
    return "advanced";
  }

  reset(): void {
    this.#snapshot = undefined;
    this.#canonical = undefined;
  }

  subscribe(listener: (snapshot: AuthoritySnapshot) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.reset();
    this.#listeners.clear();
  }

  #notify(snapshot: AuthoritySnapshot): void {
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        if (!this.#onListenerError) continue;
        try {
          this.#onListenerError(toError(error));
        } catch {
          // Diagnostics cannot affect protocol state.
        }
      }
    }
  }
}
