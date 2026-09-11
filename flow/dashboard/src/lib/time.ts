// Shared relative-time formatter. Accepts an ISO string, epoch seconds, or
// epoch milliseconds (heuristic: numbers below 1e12 are seconds).
// Note: several pages still carry local copies of this — new code should
// import from here so the copies can converge instead of multiplying.
export function timeAgo(input?: string | number | null): string {
  if (!input) return "—";
  const t =
    typeof input === "number"
      ? input < 1e12
        ? input * 1000
        : input
      : new Date(input).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "Just now";
}
