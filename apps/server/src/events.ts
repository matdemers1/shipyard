import { EventEmitter } from 'node:events';

/**
 * In-process wake-ups for the long polls (SHP-P-2): the agent's poll waits for `work`, and
 * `shipyard_deploy_status` / `GET /deploys/:id?wait=` wait for `deploy:<id>`. One server process,
 * so an EventEmitter is enough; the database stays the source of truth — a waiter that wakes
 * re-reads it, and a waiter that times out re-reads it too.
 */
export type Topic = 'work' | `deploy:${string}` | `app:${string}`;

export class Bus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Every long-poll holds a listener; there can be many at once.
    this.emitter.setMaxListeners(0);
  }

  publish(topic: Topic): void {
    this.emitter.emit(topic);
  }

  /** Resolves true when `topic` is published, false after `timeoutMs` or when `signal` aborts. */
  wait(topic: Topic, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve(false);
        return;
      }
      const done = (value: boolean): void => {
        clearTimeout(timer);
        this.emitter.off(topic, onEvent);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onEvent = (): void => {
        done(true);
      };
      const onAbort = (): void => {
        done(false);
      };
      const timer = setTimeout(() => {
        done(false);
      }, timeoutMs);
      this.emitter.on(topic, onEvent);
      signal?.addEventListener('abort', onAbort);
    });
  }
}
