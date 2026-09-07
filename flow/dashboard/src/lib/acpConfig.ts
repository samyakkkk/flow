// Shared ACP session-config model — the model selector (category "model"),
// mode selector, and thought/reasoning toggles an agent advertises on
// session/new. Single source of truth used by BOTH the live session page
// (AgentSession) and the kickoff composer (AgentTaskComposer) — nothing
// model-related is hardcoded anywhere in the UI.

export interface ConfigSelectValue {
  value: string;
  name: string;
}

export interface ConfigOption {
  id: string;
  name: string;
  type?: string;
  category?: string;
  currentValue?: string | boolean;
  options?: ConfigSelectValue[];
}

export interface AgentModes {
  currentModeId?: string;
  availableModes?: Array<{ id: string; name: string }>;
}

// Options may arrive flat or grouped ({group, options}); flatten to leaves.
export function flattenConfigValues(raw: unknown): ConfigSelectValue[] {
  if (!Array.isArray(raw)) return [];
  const out: ConfigSelectValue[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    if (item && Array.isArray(item.options)) {
      out.push(...flattenConfigValues(item.options));
    } else if (item && typeof item.value === "string") {
      out.push({ value: item.value, name: String(item.name ?? item.value) });
    }
  }
  return out;
}

export function normalizeConfigOptions(raw: unknown): ConfigOption[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Record<string, unknown>>).map((o) => ({
    id: String(o.id),
    name: String(o.name ?? o.id),
    type: o.type as string | undefined,
    category: o.category as string | undefined,
    currentValue: o.currentValue as string | boolean | undefined,
    options: flattenConfigValues(o.options),
  }));
}

// Selector order: model, then mode, then reasoning effort, then rest.
export function configRank(category?: string): number {
  if (category === "model") return 0;
  if (category === "mode") return 1;
  if (category === "thought_level" || category === "model_config") return 2;
  return 3;
}
