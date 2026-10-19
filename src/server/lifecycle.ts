/** Overall deadline from process start to listening, including directory App Server initialization and startup cleanup. */
export const STARTUP_TIMEOUT_MS = 120_000;

/**
 * When process preparation fails, wait this long for a stop signal already in flight. If the supervisor
 * signals Node and the directory child together, the child may exit before Node handles its signal.
 */
export const STOP_SIGNAL_GRACE_MS = 1_000;

const STOP_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export type SignalSource = {
  once(event: NodeJS.Signals, listener: () => void): unknown;
  removeListener(event: NodeJS.Signals, listener: () => void): unknown;
};

/**
 * Single source of truth for process-level stop intent. Signal handlers set it synchronously; later child
 * exits and startup failures check it before choosing an exit code.
 */
export class StopIntent {
  readonly #source: SignalSource;
  readonly #requested: Promise<void>;
  #resolveRequested!: () => void;
  #stopRequested = false;
  #disposed = false;
  readonly #onSignal = (): void => {
    if (this.#stopRequested) return;
    this.#stopRequested = true;
    this.#resolveRequested();
  };

  constructor(source: SignalSource = process) {
    this.#source = source;
    this.#requested = new Promise((resolve) => {
      this.#resolveRequested = resolve;
    });
    for (const signal of STOP_SIGNALS) source.once(signal, this.#onSignal);
  }

  get stopRequested(): boolean {
    return this.#stopRequested;
  }

  whenRequested(): Promise<void> {
    return this.#requested;
  }

  /** True if a stop signal has arrived or arrives within `ms`. */
  async arrivesWithin(ms: number): Promise<boolean> {
    if (this.#stopRequested) return true;
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      this.#requested.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const signal of STOP_SIGNALS) this.#source.removeListener(signal, this.#onSignal);
  }
}

export class StartupAbortedError extends Error {
  readonly reason: "stop" | "timeout";

  constructor(reason: "stop" | "timeout", timeoutMs: number) {
    super(reason === "stop"
      ? "A stop signal arrived during startup; startup was abandoned."
      : `Startup was not ready after ${Math.round(timeoutMs / 1_000)} seconds; startup was abandoned.`);
    this.name = "StartupAbortedError";
    this.reason = reason;
  }
}

/**
 * Cancellation source before readiness: the overall deadline or a stop signal makes `guard()` reject
 * immediately. Callers close underlying resources for abandoned external waits; this only stops awaiting them.
 */
export class StartupDeadline {
  readonly #timeoutMs: number;
  readonly #aborted: Promise<never>;
  #timer: NodeJS.Timeout | null;
  #error: StartupAbortedError | null = null;
  #rejectAborted!: (error: StartupAbortedError) => void;

  constructor(stop: StopIntent, timeoutMs: number = STARTUP_TIMEOUT_MS) {
    this.#timeoutMs = timeoutMs;
    this.#aborted = new Promise<never>((_resolve, reject) => {
      this.#rejectAborted = reject;
    });
    // The deadline can fire outside guard(); with no waiter it must not become an unhandled rejection.
    this.#aborted.catch(() => {});
    this.#timer = setTimeout(() => this.#abort("timeout"), timeoutMs);
    void stop.whenRequested().then(() => this.#abort("stop"));
    if (stop.stopRequested) this.#abort("stop");
  }

  get aborted(): boolean {
    return this.#error !== null;
  }

  check(): void {
    if (this.#error) throw this.#error;
  }

  async guard<T>(work: Promise<T>): Promise<T> {
    this.check();
    return Promise.race([work, this.#aborted]);
  }

  /** The service is ready; subsequent stop signals follow the normal shutdown path. */
  finish(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #abort(reason: "stop" | "timeout"): void {
    if (this.#error || this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#error = new StartupAbortedError(reason, this.#timeoutMs);
    this.#rejectAborted(this.#error);
  }
}
