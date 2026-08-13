// At most one native folder dialog can sit on the server's screen at a time.
// The pick routes register their osascript child here so that
// /api/fs/native-pick/cancel can dismiss it — the escape hatch for a browser
// that turns out NOT to be on the machine running Flow (a tunnel or ssh -L
// makes remote access network-indistinguishable from same-machine, so the
// dialog can open on a screen the user isn't looking at). Kept on globalThis
// because the pick and cancel route modules are bundled separately and must
// share one slot.
import type { ChildProcess } from "node:child_process";

const slot = globalThis as typeof globalThis & {
  __flowNativePick?: ChildProcess | null;
};

/** Register the child hosting the currently visible dialog. */
export function trackNativePick(child: ChildProcess): void {
  slot.__flowNativePick = child;
}

/** Clear the slot when a pick settles — only if it still owns the slot
 * (a superseding pick may have replaced it before its callback ran). */
export function untrackNativePick(child: ChildProcess): void {
  if (slot.__flowNativePick === child) slot.__flowNativePick = null;
}

/** Dismiss the pending dialog, if any. Returns whether one was pending.
 * The killed child's pick request then resolves as a cancel. */
export function cancelNativePick(): boolean {
  const child = slot.__flowNativePick;
  slot.__flowNativePick = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  child.kill();
  return true;
}
