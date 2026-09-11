// Hosted chats schedule extraction separately from the legacy recovery sweep.
// One running job and one coalesced follow-up per chat; failures wait for recovery.
export class LiveMemoryScheduler {
  private sessions = new Map<string, { timer?: ReturnType<typeof setTimeout>; running: boolean; dirty: boolean; completed: boolean; chars: number }>();
  constructor(private run: (id: string) => Promise<boolean>, private changed: () => void = () => {}, private interval = 30_000, private debounce = 2_000) {}
  pending(id: string) { const s = this.sessions.get(id); return Boolean(s?.running || s?.timer); }
  capture(id: string, chars: number, completed: boolean) {
    let s = this.sessions.get(id);
    if (!s) { s = { running: false, dirty: false, completed: false, chars: 0 }; this.sessions.set(id, s); }
    s.dirty = true;
    s.chars += chars;
    s.completed ||= completed;
    if (s.running) return;
    if (completed && s.timer) { clearTimeout(s.timer); s.timer = undefined; }
    if (!s.timer && (s.completed || s.chars >= 400)) {
      s.timer = setTimeout(() => void this.flush(id), s.completed ? this.debounce : this.interval);
      s.timer.unref?.();
      this.changed();
    }
  }
  private async flush(id: string) {
    const s = this.sessions.get(id);
    if (!s || s.running) return;
    s.timer = undefined;
    s.running = true; s.dirty = false; s.completed = false; s.chars = 0;
    this.changed();
    let succeeded = false;
    try { succeeded = await this.run(id); } catch { /* Durable checkpoint retains retry state. */ }
    finally {
      s.running = false;
      if (succeeded && s.dirty) this.capture(id, 0, s.completed);
      else this.sessions.delete(id);
      this.changed();
    }
  }
  close() { for (const s of this.sessions.values()) if (s.timer) clearTimeout(s.timer); this.sessions.clear(); }
}
