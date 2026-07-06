"use client";
import { useState, useEffect } from "react";

export type FlowMode = "local" | "prod";

export interface ModeState {
  mode: FlowMode;
  gates: { slack: string };
  loading: boolean;
}

const DEFAULT: ModeState = { mode: "local", gates: { slack: "prod_only" }, loading: true };

/**
 * useMode — client hook that fetches /api/mode once on mount.
 * Falls back to "local" if the request fails (safe default).
 */
export function useMode(): ModeState {
  const [state, setState] = useState<ModeState>(DEFAULT);

  useEffect(() => {
    fetch("/api/mode")
      .then((r) => r.json())
      .then((d) => {
        const data = d as { mode?: string; gates?: { slack?: string } };
        setState({
          mode: data.mode === "prod" ? "prod" : "local",
          gates: { slack: data.gates?.slack ?? "prod_only" },
          loading: false,
        });
      })
      .catch(() => {
        setState({ mode: "local", gates: { slack: "prod_only" }, loading: false });
      });
  }, []);

  return state;
}
