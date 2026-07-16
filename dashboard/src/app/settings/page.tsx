"use client";
import { Shell } from "@/components/Shell";
import { useState, useEffect, useCallback } from "react";
import { useMode } from "@/lib/useMode";
import { useProject } from "@/lib/useProject";
import { AccessSettings } from "@/components/AccessSettings";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SettingItem {
  key: string;
  secret: boolean;
  description: string;
  source: "db" | "env" | "default" | "unset";
  value: string | null;
  set: boolean;
}

type SectionKey = "models" | "integrations" | "behavior" | "slack";

interface SectionDef {
  label: string;
  keys: string[];
}

const SECTIONS: Record<SectionKey, SectionDef> = {
  models: {
    label: "Models & Keys",
    keys: ["OPENROUTER_API_KEY", "LLM_BASE_URL", "LLM_API_KEY", "BRAIN_MODE", "CLASSIFIER_MODEL", "GRAPH_BUILDER_MODEL", "INDEXER_RUNTIME"],
  },
  integrations: {
    label: "Integrations",
    keys: ["LINEAR_API_KEY", "FIREFLIES_API_KEY", "GITHUB_TOKEN"],
  },
  behavior: {
    label: "Behavior",
    keys: [
      "FLOW_CONFIDENCE_FLOOR",
      "FLOW_GITHUB_POLL_MS",
      "FLOW_LINEAR_POLL_MS",
      "FLOW_FIREFLIES_POLL_MS",
      "FLOW_DM_CHANNEL",
    ],
  },
  slack: {
    label: "Slack",
    keys: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
  },
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function SourceBadge({ source }: { source: SettingItem["source"] }) {
  const map: Record<
    SettingItem["source"],
    { label: string; bg: string; border: string; color: string }
  > = {
    db: {
      label: "db override",
      bg: "rgba(99,102,241,0.1)",
      border: "rgba(99,102,241,0.25)",
      color: "var(--accent-hover)",
    },
    env: {
      label: "env",
      bg: "rgba(34,197,94,0.1)",
      border: "rgba(34,197,94,0.2)",
      color: "var(--success)",
    },
    default: {
      label: "default",
      bg: "var(--surface-2)",
      border: "var(--border)",
      color: "var(--text-muted)",
    },
    unset: {
      label: "unset",
      bg: "rgba(239,68,68,0.08)",
      border: "rgba(239,68,68,0.2)",
      color: "#ef4444",
    },
  };
  const s = map[source];
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        padding: "2px 7px",
        borderRadius: 4,
        background: s.bg,
        border: `1px solid ${s.border}`,
        color: s.color,
        flexShrink: 0,
      }}
    >
      {s.label}
    </span>
  );
}

function SettingRow({
  item,
  draft,
  onDraft,
  onClear,
}: {
  item: SettingItem;
  draft: string | undefined;
  onDraft: (key: string, value: string) => void;
  onClear: (key: string) => void;
}) {
  // For secrets: show placeholder when set; show input for new values
  const isSecret = item.secret;
  const hasDraft = draft !== undefined;

  const maskedPlaceholder =
    isSecret && item.set && item.value
      ? `••••${item.value.slice(-4)}`
      : isSecret
      ? "not set"
      : item.value ?? "";

  const inputValue = hasDraft ? draft : "";

  return (
    <div
      style={{
        padding: "14px 16px",
        background: "var(--surface-2)",
        borderRadius: 8,
        border: "1px solid var(--border)",
        marginBottom: 10,
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 8,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 3,
              flexWrap: "wrap",
            }}
          >
            <code
              style={{
                fontSize: 12,
                fontWeight: 700,
                fontFamily: "ui-monospace, monospace",
                color: "var(--text-primary)",
              }}
            >
              {item.key}
            </code>
            <SourceBadge source={item.source} />
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {item.description}
          </div>
        </div>

        {/* Clear button — only visible when source is "db" */}
        {item.source === "db" && (
          <button
            onClick={() => onClear(item.key)}
            title="Clear this override (revert to env/default)"
            style={{
              padding: "4px 10px",
              borderRadius: 5,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-muted)",
              fontSize: 11,
              cursor: "pointer",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            Clear override
          </button>
        )}
      </div>

      {/* Input */}
      <input
        type={isSecret ? "password" : "text"}
        value={inputValue}
        onChange={(e) => onDraft(item.key, e.target.value)}
        placeholder={
          isSecret
            ? item.set
              ? maskedPlaceholder + " — enter new value to change"
              : "Enter value..."
            : item.value ?? "Enter value..."
        }
        autoComplete="off"
        style={{
          width: "100%",
          padding: "8px 11px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--surface)",
          color: "var(--text-primary)",
          fontSize: 12,
          fontFamily: isSecret ? "ui-monospace, monospace" : "inherit",
          outline: "none",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}

function Section({
  title,
  children,
  onSave,
  saving,
  error,
  success,
  disabled,
  disabledReason,
}: {
  title: string;
  children: React.ReactNode;
  onSave: () => void;
  saving: boolean;
  error: string | null;
  success: string | null;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "22px 24px",
        marginBottom: 24,
      }}
    >
      <h2
        style={{
          margin: "0 0 18px",
          fontSize: 14,
          fontWeight: 600,
          color: "var(--text-primary)",
          borderBottom: "1px solid var(--border)",
          paddingBottom: 12,
        }}
      >
        {title}
      </h2>

      {disabled && disabledReason && (
        <div
          style={{
            padding: "10px 14px",
            background: "var(--surface-2)",
            border: "1px dashed var(--border)",
            borderRadius: 7,
            marginBottom: 16,
            fontSize: 12,
            color: "var(--text-muted)",
          }}
        >
          {disabledReason}
        </div>
      )}

      {children}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginTop: 16,
          paddingTop: 12,
          borderTop: "1px solid var(--border)",
        }}
      >
        <button
          onClick={onSave}
          disabled={saving || disabled}
          style={{
            padding: "8px 20px",
            borderRadius: 6,
            border: "none",
            background: saving || disabled ? "var(--surface-2)" : "var(--accent)",
            color: saving || disabled ? "var(--text-muted)" : "#fff",
            fontSize: 13,
            fontWeight: 600,
            cursor: saving || disabled ? "not-allowed" : "pointer",
          }}
        >
          {saving ? "Saving..." : "Save"}
        </button>

        {error && (
          <span style={{ fontSize: 12, color: "#ef4444" }}>{error}</span>
        )}
        {success && !error && (
          <span style={{ fontSize: 12, color: "var(--success)" }}>{success}</span>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { mode, loading: modeLoading } = useMode();
  const { prefix } = useProject();
  const [settings, setSettings] = useState<SettingItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Per-key draft values: undefined = untouched, string = user typed something
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // Per-section state
  const [saving, setSaving] = useState<Record<SectionKey, boolean>>({
    models: false,
    integrations: false,
    behavior: false,
    slack: false,
  });
  const [errors, setErrors] = useState<Record<SectionKey, string | null>>({
    models: null,
    integrations: null,
    behavior: null,
    slack: null,
  });
  const [successes, setSuccesses] = useState<Record<SectionKey, string | null>>({
    models: null,
    integrations: null,
    behavior: null,
    slack: null,
  });

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(prefix("/api/settings"));
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        setLoadError(d.error ?? `Error ${res.status}`);
        return;
      }
      const data = (await res.json()) as SettingItem[];
      setSettings(data);
    } catch (e) {
      setLoadError(`Network error: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [prefix]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  function setDraft(key: string, value: string) {
    setDrafts((prev) => ({ ...prev, [key]: value }));
  }

  function clearDraft(key: string) {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function handleClear(key: string) {
    // Set draft to "" which tells PUT to delete the override
    setDrafts((prev) => ({ ...prev, [key]: "" }));
  }

  async function handleSaveSection(sectionKey: SectionKey) {
    const sectionKeys = SECTIONS[sectionKey].keys;

    // Collect dirty drafts for this section
    const payload: Record<string, string> = {};
    for (const key of sectionKeys) {
      if (key in drafts) {
        payload[key] = drafts[key]; // "" means delete override
      }
    }

    if (Object.keys(payload).length === 0) {
      setSuccesses((prev) => ({ ...prev, [sectionKey]: "No changes to save." }));
      setTimeout(() => setSuccesses((prev) => ({ ...prev, [sectionKey]: null })), 3000);
      return;
    }

    setSaving((prev) => ({ ...prev, [sectionKey]: true }));
    setErrors((prev) => ({ ...prev, [sectionKey]: null }));
    setSuccesses((prev) => ({ ...prev, [sectionKey]: null }));

    try {
      const res = await fetch(prefix("/api/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { updated?: string[]; error?: string };

      if (!res.ok) {
        setErrors((prev) => ({
          ...prev,
          [sectionKey]: data.error ?? `Save failed (${res.status})`,
        }));
        return;
      }

      // Optimistic: clear the drafts for saved keys
      setDrafts((prev) => {
        const next = { ...prev };
        for (const key of sectionKeys) delete next[key];
        return next;
      });

      // Re-fetch to get fresh source/value from orchestrator
      await fetchSettings();
      setSuccesses((prev) => ({
        ...prev,
        [sectionKey]: `Saved ${data.updated?.length ?? 0} key(s).`,
      }));
      setTimeout(() => setSuccesses((prev) => ({ ...prev, [sectionKey]: null })), 4000);
    } catch (e) {
      setErrors((prev) => ({
        ...prev,
        [sectionKey]: `Network error: ${(e as Error).message}`,
      }));
    } finally {
      setSaving((prev) => ({ ...prev, [sectionKey]: false }));
    }
  }

  const isLocalMode = !modeLoading && mode === "local";
  const settingsMap = new Map(settings.map((s) => [s.key, s]));

  return (
    <Shell>
      <div style={{ marginBottom: 28 }}>
        <h1
          style={{
            margin: 0,
            fontSize: 22,
            fontWeight: 700,
            color: "var(--text-primary)",
          }}
        >
          Settings
        </h1>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>
          All project configuration. Changes are stored as orchestrator DB overrides and take
          precedence over environment variables.
        </p>
      </div>

      {loadError && (
        <div
          style={{
            padding: "12px 16px",
            background: "rgba(239,68,68,0.07)",
            border: "1px solid rgba(239,68,68,0.2)",
            borderRadius: 7,
            marginBottom: 20,
            fontSize: 13,
            color: "#ef4444",
          }}
        >
          {loadError}
        </div>
      )}

      {loading && (
        <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "40px 0" }}>
          Loading settings...
        </div>
      )}

      {!loading && !loadError && (
        <>
          {(Object.entries(SECTIONS) as [SectionKey, SectionDef][]).map(
            ([sectionKey, sectionDef]) => {
              const isSlack = sectionKey === "slack";
              const isDisabled = isSlack && isLocalMode;

              return (
                <Section
                  key={sectionKey}
                  title={sectionDef.label}
                  onSave={() => handleSaveSection(sectionKey)}
                  saving={saving[sectionKey]}
                  error={errors[sectionKey]}
                  success={successes[sectionKey]}
                  disabled={isDisabled}
                  disabledReason={
                    isDisabled
                      ? "Always-on only — deploy to enable. Slack tokens can only be used in a deployed (prod) instance."
                      : undefined
                  }
                >
                  {sectionDef.keys.map((key) => {
                    const item = settingsMap.get(key) ?? {
                      key,
                      secret: false,
                      description: "",
                      source: "unset" as const,
                      value: null,
                      set: false,
                    };
                    return (
                      <SettingRow
                        key={key}
                        item={item}
                        draft={drafts[key]}
                        onDraft={setDraft}
                        onClear={handleClear}
                      />
                    );
                  })}
                </Section>
              );
            }
          )}
          <AccessSettings />
        </>
      )}
    </Shell>
  );
}
