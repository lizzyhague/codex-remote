/** 从进程启动到开始监听的总时限；覆盖目录 App Server 初始化和启动清理。 */
export const STARTUP_TIMEOUT_MS = 120_000;

/**
 * 进程准备以失败结束时，再等这么久看停止信号是否正在路上。进程管理器同时向 Node
 * 和目录子进程发信号时，子进程可能先退出、Node 稍后才处理到自己的信号。
 */
export const STOP_SIGNAL_GRACE_MS = 1_000;

const STOP_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export type SignalSource = {
  once(event: NodeJS.Signals, listener: () => void): unknown;
  removeListener(event: NodeJS.Signals, listener: () => void): unknown;
};

/**
 * 进程级停止意图的唯一权威。信号回调里同步置位，任何后到的子进程退出、启动失败都
 * 先查这里再决定退出码。
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

  /** 已经收到或在 `ms` 内收到停止信号时为 true。 */
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
      ? "启动期间收到停止信号，已放弃启动。"
      : `启动超过 ${Math.round(timeoutMs / 1_000)} 秒仍未就绪，放弃启动。`);
    this.name = "StartupAbortedError";
    this.reason = reason;
  }
}

/**
 * ready 前阶段的取消源：总时限到点或收到停止信号都会让 `guard()` 立即拒绝。被放弃的
 * 外部等待由调用方关闭其底层资源来收口，这里只负责不再等它。
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
    // guard() 之外也可能先到点；没有等待者时不能变成未处理拒绝。
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

  /** 服务已经就绪；之后的停止信号走正常关闭流程。 */
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
