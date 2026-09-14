// @effect-diagnostics nodeBuiltinImport:off - Shared native disk cache is independent of the Effect host.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

type Summary = { readonly id: string; readonly revision: number; readonly updatedAt: number };
type CachedDocument<D> = { value: D; hash: string };

/** Read-only replica: mutations and agent tools always go to the remote authority. */
export class CloudReadCache<S, D extends Summary> {
  private snapshot: S | undefined;
  private summaries = new Map<string, Summary>();
  private stopped = false;
  private documents = new Map<string, CachedDocument<D>>();
  private pendingDocuments = new Map<string, Promise<D | null>>();
  private pending: Promise<S> | undefined;
  private checkedAt = -Infinity;
  private generation = 0;
  private writes: Promise<void> = Promise.resolve();
  private savedHash: string | undefined;
  private readonly loaded: Promise<void>;
  error: string | undefined;

  private readonly options: {
    file: string;
    state: () => Promise<S>;
    document: (id: string) => Promise<D | null>;
    summaries: (state: S) => readonly Summary[];
    decodeState: (value: unknown) => S;
    decodeDocument: (value: unknown) => D;
    now?: () => number;
    refreshMs?: number;
  };

  constructor(options: CloudReadCache<S, D>["options"]) {
    this.options = options;
    this.loaded = this.restore();
  }

  private async restore() {
    try {
      const saved = JSON.parse(await NodeFSP.readFile(this.options.file, "utf8")) as {
        version: number;
        state: unknown;
        documents: { value: unknown; hash: string }[];
      };
      if (saved.version !== 1) return;
      const snapshot = this.options.decodeState(saved.state);
      const documents = new Map<string, CachedDocument<D>>();
      for (const entry of saved.documents) {
        const value = this.options.decodeDocument(entry.value);
        if (this.hash(value) === entry.hash) documents.set(value.id, { value, hash: entry.hash });
      }
      this.snapshot = snapshot;
      this.summaries = new Map(
        this.options.summaries(snapshot).map((summary) => [summary.id, summary]),
      );
      this.documents = documents;
    } catch {
      // Missing, obsolete, or corrupt cache files are ordinary cold starts.
    }
  }

  private hash(value: D) {
    return NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  private save() {
    // Serialize atomic replacements so prefetches cannot overwrite a newer snapshot.
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        const data = JSON.stringify({
          version: 1,
          state: this.snapshot,
          documents: [...this.documents.values()],
        });
        const hash = NodeCrypto.createHash("sha256").update(data).digest("hex");
        if (hash === this.savedHash) return;
        await NodeFSP.mkdir(NodePath.dirname(this.options.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.options.file}.tmp`;
        await NodeFSP.writeFile(temporary, data, { mode: 0o600 });
        await NodeFSP.rename(temporary, this.options.file);
        this.savedHash = hash;
      });
    // A full disk must not make an otherwise healthy cloud connection unusable.
    void this.writes.catch(() => {});
  }

  invalidate() {
    this.generation++;
    this.checkedAt = -Infinity;
  }

  async state(): Promise<S> {
    await this.loaded;
    if (this.snapshot === undefined) return this.refresh();
    if ((this.options.now ?? Date.now)() - this.checkedAt >= (this.options.refreshMs ?? 10_000))
      void this.refresh().catch(() => {});
    return this.snapshot;
  }

  /** Also serves as a deterministic drain for the owner and tests. */
  async refresh(): Promise<S> {
    await this.loaded;
    if (this.stopped) throw new Error("Cloud cache is closed.");
    if (this.pending) return this.pending;
    const generation = this.generation;
    const request = (async () => {
      try {
        const snapshot = await this.options.state();
        if (generation !== this.generation) return snapshot;
        this.snapshot = snapshot;
        this.error = undefined;
        const summaries = this.options.summaries(snapshot);
        this.summaries = new Map(summaries.map((summary) => [summary.id, summary]));
        const ids = new Set(summaries.map((summary) => summary.id));
        for (const id of this.documents.keys()) if (!ids.has(id)) this.documents.delete(id);
        this.save();
        // Warm the library without holding up the graph or overwhelming the cloud.
        this.warming = this.warm(summaries, generation);
        return snapshot;
      } catch (error) {
        this.error = error instanceof Error ? error.message : "Cloud Brain unavailable";
        throw error;
      } finally {
        this.checkedAt =
          generation === this.generation ? (this.options.now ?? Date.now)() : -Infinity;
      }
    })();
    this.pending = request;
    try {
      return await request;
    } finally {
      if (this.pending === request) this.pending = undefined;
    }
  }

  private warming: Promise<void> = Promise.resolve();
  private async warm(summaries: readonly Summary[], generation: number) {
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, summaries.length) }, async () => {
        while (index < summaries.length && generation === this.generation) {
          const summary = summaries[index++]!;
          await this.document(summary.id, false).catch(() => {});
        }
      }),
    );
    if (generation === this.generation) this.save();
  }

  async document(id: string, persist = true): Promise<D | null> {
    await this.loaded;
    if (this.stopped) throw new Error("Cloud cache is closed.");
    const summary = this.summaries.get(id);
    const cached = this.documents.get(id)?.value;
    if (
      cached &&
      summary &&
      cached.revision === summary.revision &&
      cached.updatedAt === summary.updatedAt
    )
      return cached;
    const pending = this.pendingDocuments.get(id);
    if (pending) return pending;
    const generation = this.generation;
    const request = this.options.document(id).then((value) => {
      if (generation === this.generation) {
        if (value) this.documents.set(id, { value, hash: this.hash(value) });
        else this.documents.delete(id);
      }
      return value;
    });
    this.pendingDocuments.set(id, request);
    try {
      const value = await request;
      // Prefetch persists the whole batch once. Direct reads also survive restarts.
      if (persist && generation === this.generation) this.save();
      return value;
    } finally {
      if (this.pendingDocuments.get(id) === request) this.pendingDocuments.delete(id);
    }
  }

  async close() {
    this.stopped = true;
    this.generation++;
    await this.drain();
  }

  async drain() {
    await this.loaded;
    await this.pending?.catch(() => {});
    await this.warming;
    await Promise.allSettled(this.pendingDocuments.values());
    await this.writes.catch(() => {});
  }
}
