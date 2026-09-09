// @effect-diagnostics globalTimers:off - Idle native-process timers belong to this Promise callback boundary and are cleared on every retirement path.
type Entry<T> = {
  value: T;
  busy: boolean;
  lastUsed: number;
  timer: ReturnType<typeof setTimeout> | undefined;
};

/** Keep warm native segments bounded; their logical conversations live in the Brain. */
export class CuratorSessions<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly closing = new Set<Promise<void>>();
  private disposed = false;
  private readonly creating = new Set<string>();

  private readonly close: (value: T) => Promise<void>;
  private readonly idleMs: number;
  private readonly maxIdle: number;
  private useSequence = 0;
  constructor(close: (value: T) => Promise<void>, idleMs = 30 * 60_000, maxIdle = 8) {
    this.close = close;
    this.idleMs = idleMs;
    this.maxIdle = maxIdle;
  }

  private retire(key: string, entry: Entry<T>): Promise<void> {
    if (this.entries.get(key) !== entry) return Promise.resolve();
    this.entries.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    const closing = this.close(entry.value);
    this.closing.add(closing);
    void closing.finally(() => this.closing.delete(closing)).catch(() => {});
    return closing;
  }

  async acquire(key: string, renew: boolean, create: () => Promise<T>): Promise<T | undefined> {
    if (this.disposed) throw new Error("Background extraction is shutting down.");
    let entry = this.entries.get(key);
    if (entry?.busy || this.creating.has(key))
      throw new Error("This conversation already has an extraction in progress.");
    if (renew && entry) {
      await this.retire(key, entry);
      entry = undefined;
    }
    // The host cannot reconstruct a source window from a delta. Ask its owner
    // for full bounded context when an idle segment has expired or been evicted.
    if (!entry && !renew) return undefined;
    if (!entry) {
      this.creating.add(key);
      let value: T;
      try {
        value = await create();
      } finally {
        this.creating.delete(key);
      }
      if (this.disposed) {
        await this.close(value);
        throw new Error("Background extraction is shutting down.");
      }
      entry = { value, busy: true, lastUsed: ++this.useSequence, timer: undefined };
      this.entries.set(key, entry);
    } else {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
      entry.busy = true;
    }
    return entry.value;
  }

  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || this.disposed) return;
    entry.busy = false;
    entry.lastUsed = ++this.useSequence;
    entry.timer = setTimeout(() => void this.retire(key, entry).catch(() => {}), this.idleMs);
    entry.timer.unref?.();
    const idle = [...this.entries]
      .filter(([, value]) => !value.busy)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [id, value] of idle.slice(0, Math.max(0, idle.length - this.maxIdle)))
      void this.retire(id, value).catch(() => {});
  }

  async discard(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry) await this.retire(key, entry);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.entries].map(([key, entry]) => this.retire(key, entry)));
    await Promise.allSettled(this.closing);
  }
}
