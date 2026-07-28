"use client";
// Shared renderer for an agent's advertised config options (model selector,
// mode selector, thought/reasoning toggles) — used by BOTH the live session
// page (AgentSession) and the kickoff composer (AgentTaskComposer). Options
// come from ACP verbatim; nothing is hardcoded.
//
// The expanded-strip variant (used by the kickoff composer) renders compact
// pill toggles that open a floating card above the bar when clicked.

import { useCallback, useRef, useEffect, useState } from "react";
import { configRank, type AgentModes, type ConfigOption } from "@/lib/acpConfig";

interface AgentConfigControlsProps {
  configOptions: ConfigOption[];
  modes: AgentModes | null;
  values?: Record<string, string | boolean>;
  modeValue?: string;
  onChange: (configId: string, value: string | boolean) => void;
  onModeChange?: (modeId: string) => void;
  disabled?: boolean;
  className?: string;
}

const mono = { fontFamily: "var(--font-mono)" } as const;

// ---------------------------------------------------------------------------
// Compact pill-toggles (kickoff composer) — small clickable pills that open
// a floating options card above the bar.

const EFFORT_ICONS: Record<string, string> = {
  default: "⚡",
  low: "💤",
  medium: "⚡",
  high: "🔥",
  xhigh: "🔥",
  max: "🔥",
};

const MODE_ICONS: Record<string, string> = {
  auto: "🤖",
  default: "🖐️",
  manual: "🖐️",
  acceptEdits: "✏️",
  plan: "📋",
  dontAsk: "🔕",
  bypassPermissions: "🔓",
  "read-only": "👁️",
  agent: "⚡",
};

function shortLabel(category: string, optionName: string, value: string): string {
  if (category === "mode") return value;
  if (category === "thought_level") return value;
  return optionName;
}

function iconFor(category: string, value: string): string {
  const v = String(value).toLowerCase();
  if (category === "mode") return MODE_ICONS[v] ?? "⚙️";
  if (category === "thought_level") return EFFORT_ICONS[v] ?? "⚡";
  if (category === "model_config") return "⚙️";
  return "⚙️";
}

// A single expandable pill — compact pill button that opens a floating options
// card above the bar when clicked. Closes on outside click.
function ExpandablePill({
  configId,
  label,
  icon,
  options,
  currentValue,
  disabled,
  onChange,
}: {
  configId: string;
  label: string;
  icon: string;
  options: Array<{ value: string; name: string; description?: string }>;
  currentValue: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={disabled}
        className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-line bg-cream/80 text-[10.5px] text-text-muted hover:text-ink hover:border-ink/30 transition-colors cursor-pointer disabled:opacity-50"
        style={mono}
        title={label}
      >
        <span>{icon}</span>
        <span>{shortLabel(options[0] ? "" : "", label, currentValue)}</span>
      </button>
      {open && (
        <div
          className="absolute bottom-full left-0 mb-2 rounded-lg border border-line bg-paper shadow-lg p-1.5 flex items-center gap-1 z-50 whitespace-nowrap"
          style={{ minWidth: "max-content" }}
        >
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={`px-2.5 py-1 rounded-md text-[10.5px] font-medium transition-colors cursor-pointer ${
                currentValue === opt.value
                  ? "bg-ink text-paper shadow-xs"
                  : "text-text-muted hover:text-ink hover:bg-sand"
              }`}
              style={mono}
              title={opt.description ?? opt.name}
            >
              {opt.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// A simple boolean toggle pill — small and compact.
function BooleanPill({
  configId,
  label,
  on,
  disabled,
  onChange,
}: {
  configId: string;
  label: string;
  on: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      disabled={disabled}
      className={`flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10.5px] transition-colors cursor-pointer disabled:opacity-50 ${
        on
          ? "bg-accent/10 border-accent/40 text-ink font-medium"
          : "bg-cream/80 border-line text-text-muted hover:text-ink"
      }`}
      style={mono}
      title={label}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${on ? "bg-ok" : "bg-text-muted/40"}`} />
      <span>{shortLabel("bool", label, on ? "on" : "off")}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Standard inline selects (live session page) — full-size dropdowns in the
// session header, unchanged from previous behavior.

function InlineSelects({
  configOptions,
  modes,
  values,
  modeValue,
  disabled,
  onChange,
  onModeChange,
}: Omit<AgentConfigControlsProps, "className">) {
  const selects = [...configOptions]
    .filter((o) => o.type !== "boolean" && (o.options?.length ?? 0) > 0)
    .sort((a, b) => configRank(a.category) - configRank(b.category));
  const booleans = configOptions.filter((o) => o.type === "boolean");

  return (
    <>
      {selects.map((o) => {
        const raw = values?.[o.id];
        const value = typeof raw === "string" ? raw : typeof o.currentValue === "string" ? o.currentValue : "";
        return (
          <select
            key={o.id}
            value={value}
            onChange={(e) => onChange(o.id, e.target.value)}
            disabled={disabled}
            className="rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[11px] text-ink disabled:opacity-50 cursor-pointer focus:outline-none focus:border-ink/30"
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
      {selects.length === 0 && booleans.length === 0 && modes?.availableModes && modes.availableModes.length > 0 && (
        <select
          value={modeValue ?? modes.currentModeId ?? ""}
          onChange={(e) => onModeChange?.(e.target.value)}
          disabled={disabled}
          className="rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[11px] text-ink disabled:opacity-50 cursor-pointer focus:outline-none focus:border-ink/30"
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
    </>
  );
}

// ---------------------------------------------------------------------------
// Main component — choose compact or inline mode via the `compact` prop.

interface AgentConfigControlsAllProps extends AgentConfigControlsProps {
  compact?: boolean;
}

export function AgentConfigControls({
  compact,
  ...props
}: AgentConfigControlsAllProps) {
  if (compact) return <CompactPills {...props} />;
  return <InlineSelects {...props} />;
}

// Compact pill-toggles variant for the kickoff composer bottom bar.
function CompactPills({
  configOptions,
  modes,
  values,
  modeValue,
  disabled,
  onChange,
  onModeChange,
}: Omit<AgentConfigControlsProps, "className">) {
  // Model: always show as a labeled chip (the model NAME should be visible).
  const modelOption = configOptions.find(
    (o) => o.category === "model" && o.type !== "boolean" && (o.options?.length ?? 0) > 0
  );

  // Non-model select options: mode, effort, etc. — expandable pill toggles.
  const otherSelects = [...configOptions]
    .filter(
      (o) =>
        o.category !== "model" &&
        o.type !== "boolean" &&
        (o.options?.length ?? 0) > 0
    )
    .sort((a, b) => configRank(a.category) - configRank(b.category));

  // Boolean options: thinking/fast-mode toggles.
  const booleans = configOptions.filter((o) => o.type === "boolean");

  // Fallback: modes when no configOptions.
  const useModesFallback =
    !modelOption && otherSelects.length === 0 && booleans.length === 0 &&
    modes?.availableModes && modes.availableModes.length > 0;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {/* Model chip — always shows the model name. */}
      {modelOption && (() => {
        const raw = values?.[modelOption.id];
        const current = typeof raw === "string" ? raw : typeof modelOption.currentValue === "string" ? modelOption.currentValue : "";
        const selected = modelOption.options!.find((o) => o.value === current);
        return (
          <ExpandablePill
            configId={modelOption.id}
            label={selected?.name ?? modelOption.name}
            icon="🤖"
            options={modelOption.options!}
            currentValue={current ?? ""}
            disabled={disabled}
            onChange={(v) => onChange(modelOption.id, v)}
          />
        );
      })()}

      {/* Mode pills — small toggle with expandable options card. */}
      {otherSelects.map((o) => {
        const raw = values?.[o.id];
        const current = typeof raw === "string" ? raw : typeof o.currentValue === "string" ? o.currentValue : "";
        const icon = iconFor(o.category ?? "", current ?? "");
        const label = o.category === "mode" ? "Mode" : o.category === "thought_level" ? "Effort" : o.name;
        return (
          <ExpandablePill
            key={o.id}
            configId={o.id}
            label={label}
            icon={icon}
            options={o.options!}
            currentValue={current ?? ""}
            disabled={disabled}
            onChange={(v) => onChange(o.id, v)}
          />
        );
      })}

      {/* Boolean toggles — small pills that toggle on click. */}
      {booleans.map((o) => {
        const raw = values?.[o.id];
        const on = typeof raw === "boolean" ? raw : o.currentValue === true;
        return (
          <BooleanPill
            key={o.id}
            configId={o.id}
            label={o.name}
            on={on}
            disabled={disabled}
            onChange={(v) => onChange(o.id, v)}
          />
        );
      })}

      {/* Modes fallback. */}
      {useModesFallback && (
        <ExpandablePill
          configId="__mode_fallback"
          label="Mode"
          icon="⚙️"
          options={modes!.availableModes!.map((m) => ({ value: m.id, name: m.name }))}
          currentValue={modeValue ?? modes!.currentModeId ?? ""}
          disabled={disabled}
          onChange={(v) => onModeChange?.(v)}
        />
      )}
    </div>
  );
}
