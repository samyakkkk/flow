import type { SlackApi } from "./archive.js";

// The receiving installation's team_id is NOT the sender's identity in Connect.
export function internalUserGuard(teamId: string, api: SlackApi): (userId: string) => Promise<boolean> {
  const cache = new Map<string, { allowed: boolean; expires: number }>();
  return async (userId) => {
    if (!teamId || !userId) return false;
    const cached = cache.get(userId);
    if (cached && cached.expires > Date.now()) return cached.allowed;
    try {
      const { user } = await api("users.info", { user: userId });
      const allowed = !!user && !user.deleted && !user.is_bot && user.team_id === teamId;
      cache.set(userId, { allowed, expires: Date.now() + 300_000 });
      return allowed;
    } catch { return false; }
  };
}
