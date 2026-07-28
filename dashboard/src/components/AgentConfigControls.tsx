"use client";
// Shared renderer for an agent's advertised config options (model selector,
// mode selector, thought/reasoning toggles) — used by BOTH the live session
// page (AgentSession) and the kickoff composer (AgentTaskComposer). Options
// come from ACP verbatim; nothing is hardcoded.

import { configRank, type AgentModes, type ConfigOption } from "@/lib/acpConfig";

interface AgentConfigControlsProps {
  configOptions: ConfigOption[];
  modes: AgentModes | null;
  // Composer-local value overrides; falls back to the option's currentValue.
  values?: Record<string, string | boolean>;
  modeValue?: string;
  onChange: (configId: string, value: string | boolean) => void;
  onModeChange?: (modeId: string) => void;
  disabled?: boolean;
  className?: string;
}

const mono = { fontFamily: "var(--font-mono)" } as const;

export function AgentConfigControls({
  configOptions,
  modes,
  values,
  modeValue,
  onChange,
  onModeChange,
  disabled,
  className = "",
}: AgentConfigControlsProps) {
  const selects = [...configOptions]
    .filter((o) => o.type !== "boolean" && (o.options?.length ?? 0) > 0)
    .sort((a, b) => configRank(a.category) - configRank(b.category));
  const booleans = configOptions.filter((o) => o.type === "boolean");

  return (
    <div className={`flex items-center gap-1.5 flex-wrap ${className}`}>
      {selects.map((o) => {
        const raw = values?.[o.id];
        const value = typeof raw === "string" ? raw : typeof o.currentValue === "string" ? o.currentValue : "";
        return (
          <select
            key={o.id}
            value={value}
            onChange={(e) => onChange(o.id, e.target.value)}
            disabled={disabled}
            className="rounded-lg border border-line bg-cream px-2 py-1 text-[11px] text-ink disabled:opacity-50 cursor-pointer focus:outline-none focus:border-ink/30"
            style={mono}
            title={o.name}
          >
            {o.options!.map((v) => (
              <option key={v.value} value={v.value}>
                {o.category === "model" ? v.name : `${o.name}: ${v.name}`}
              </option>
            ))}
          </select>
        );
      })}
      {/* Boolean toggles (e.g. thinking/reasoning switches) as small pills. */}
      {booleans.map((o) => {
        const raw = values?.[o.id];
        const on = typeof raw === "boolean" ? raw : o.currentValue === true;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id, !on)}
            disabled={disabled}
            className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] transition-colors cursor-pointer disabled:opacity-50 ${
              on
                ? "bg-accent/10 border-accent/40 text-ink font-medium"
                : "bg-cream border-line text-text-muted hover:text-ink"
            }`}
            style={mono}
            title={o.name}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${on ? "bg-ok" : "bg-text-muted/40"}`} />
            <span>
              {o.name} {on ? "On" : "Off"}
            </span>
          </button>
        );
      })}
      {/* Fallback: agents that expose modes but not configOptions. */}
      {selects.length === 0 && booleans.length === 0 && modes?.availableModes && modes.availableModes.length > 0 && (
        <select
          value={modeValue ?? modes.currentModeId ?? ""}
          onChange={(e) => onModeChange?.(e.target.value)}
          disabled={disabled}
          className="rounded-lg border border-line bg-cream px-2 py-1 text-[11px] text-ink disabled:opacity-50 cursor-pointer focus:outline-none focus:border-ink/30"
          style={mono}
          title="Agent mode"
        >
          {modes.availableModes.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
