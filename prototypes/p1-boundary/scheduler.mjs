import { PROFILE, BoundaryError } from "./input.mjs";

// Promise workers, not Android threads. Running work releases capacity only
// when it settles, even if it ignores its cancellation signal.
export class BoundedScheduler {
  #running = 0;
  #busy = new Set();
  #queue = [];

  snapshot() { return { running: this.#running, queued: this.#queue.length, busy_scopes: this.#busy.size }; }

  run(scope, work, signal) {
    if (signal?.aborted) return Promise.reject(new BoundaryError("cancelled"));
    const immediate = this.#running < PROFILE.running_global && !this.#busy.has(scope);
    if (!immediate && (this.#queue.length >= PROFILE.queued_global
      || this.#queue.filter(job => job.scope === scope).length >= PROFILE.queued_per_scope)) {
      return Promise.reject(new BoundaryError("queue_full"));
    }
    return new Promise((resolve, reject) => {
      const job = { scope, work, resolve, reject, controller: new AbortController(), signal };
      job.abort = () => {
        job.controller.abort();
        const index = this.#queue.indexOf(job);
        if (index >= 0) {
          this.#queue.splice(index, 1);
          signal?.removeEventListener("abort", job.abort);
          reject(new BoundaryError("cancelled"));
          this.#drain();
        }
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      if (immediate) this.#start(job);
      else this.#queue.push(job);
    });
  }

  #start(job) {
    this.#running++;
    this.#busy.add(job.scope);
    Promise.resolve().then(() => {
      if (job.controller.signal.aborted) throw new BoundaryError("cancelled");
      return job.work(job.controller.signal);
    }).then(value => {
      if (job.controller.signal.aborted) throw new BoundaryError("cancelled");
      return value;
    }).then(value => this.#finish(job, null, value), error => this.#finish(job, error));
  }

  #finish(job, error, value) {
    job.signal?.removeEventListener("abort", job.abort);
    this.#running--;
    this.#busy.delete(job.scope);
    this.#drain();
    if (job.controller.signal.aborted) job.reject(new BoundaryError("cancelled"));
    else if (error) job.reject(error);
    else job.resolve(value);
  }

  #drain() {
    while (this.#running < PROFILE.running_global) {
      const index = this.#queue.findIndex(job => !this.#busy.has(job.scope));
      if (index < 0) break;
      this.#start(this.#queue.splice(index, 1)[0]);
    }
  }
}
