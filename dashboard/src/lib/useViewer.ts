"use client";
import { useState, useEffect } from "react";
import { useProject } from "@/lib/useProject";

export interface ViewerUser {
  id: string;
  email: string;
  role: "owner" | "member";
}

export interface Viewer {
  mode: "local" | "prod";
  user: ViewerUser | null;
  isOwner: boolean;
  /**
   * May the viewer create/edit team integrations (GitHub PAT, Slack, Linear,
   * source connect)? Mirrors the server-side `canManageIntegrations()`:
   * local mode = single trusted user = yes; prod = owner only. Members get a
   * read-only view instead of edit controls that would just 403 on submit.
   */
  canManageIntegrations: boolean;
  loading: boolean;
}

// Fail CLOSED while loading so a member never sees a flash of owner-only
// controls before the role resolves. Owners briefly see the read-only state,
// which is harmless and corrects within one fetch.
const LOADING: Viewer = {
  mode: "prod",
  user: null,
  isOwner: false,
  canManageIntegrations: false,
  loading: true,
};

/**
 * useViewer — who is looking, and what may they manage. Fetches
 * /api/auth/status once on mount. In local mode there are no users, but the
 * single operator is trusted, so canManageIntegrations is true.
 */
export function useViewer(): Viewer {
  const { prefix } = useProject();
  const [state, setState] = useState<Viewer>(LOADING);

  useEffect(() => {
    fetch(prefix("/api/auth/status"), { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const data = d as { mode?: string; user?: ViewerUser | null };
        const mode = data.mode === "prod" ? "prod" : "local";
        const user = data.user ?? null;
        const isOwner = user?.role === "owner";
        setState({
          mode,
          user,
          isOwner,
          canManageIntegrations: mode === "local" || isOwner,
          loading: false,
        });
      })
      .catch(() => setState({ ...LOADING, loading: false }));
  }, [prefix]);

  return state;
}
