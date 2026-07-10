"use client";
import { useState, useEffect } from "react";

export interface UpdateStatus {
  behind: number;
  current?: string;
  latest?: string;
}

/**
 * useUpdateStatus — polls /api/update-status so long-running dashboards learn
 * a newer flow is available (flow up only updates at start). The server
 * caches the git fetch for 30 minutes; the client re-asks hourly, which keeps
 * a dashboard that stays open for days honest without meaningful cost.
 */
export function useUpdateStatus(): UpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>({ behind: 0 });

  useEffect(() => {
    let alive = true;
    const check = () => {
      fetch("/api/update-status")
        .then((r) => (r.ok ? r.json() : { behind: 0 }))
        .then((d) => {
          if (alive) setStatus({ behind: Number(d.behind) || 0, current: d.current, latest: d.latest });
        })
        .catch(() => {
          /* offline or unauthorized — no badge */
        });
    };
    check();
    const t = setInterval(check, 60 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return status;
}
