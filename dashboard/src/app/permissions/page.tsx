"use client";
import { Shell } from "@/components/Shell";
import { useEffect, useState, useCallback } from "react";
import { useProject } from "@/lib/useProject";

type Decision = "auto" | "propose" | "off";

interface PoliciesResponse {
  effective: Record<string, Decision>;
  overrides: Record<string, Decision>;
  defaults: Record<string, Decision>;
}

const SOURCE_GROUPS: Record<string, string[]> = {
  "Slack Ambient": [
    "slack_ambient.noise",
    "slack_ambient.knowledge_claim",
    "slack_ambient.correction",
    "slack_ambient.task_discussion",
    "slack_ambient.ticket_status_signal",
    "slack_ambient.question_about_system",
    "slack_ambient.sensitive",
  ],
  "Slack Mention": [
    "slack_mention.question",
    "slack_mention.command",
    "slack_mention.feedback",
  ],
  "GitHub Merge": [
    "github_merge.skip",
    "github_merge.index_worthy",
  ],
  "Linear Ticket": [
    "linear_ticket.needs_context",
    "linear_ticket.duplicate_candidate",
    "linear_ticket.unresolvable",
    "linear_ticket.not_applicable",
  ],
  "Meeting Segment": [
    "meeting_segment.decision",
    "meeting_segment.action_item",
    "meeting_segment.knowledge_claim",
    "meeting_segment.open_question",
    "meeting_segment.noise",
  ],
};

function classificationLabel(key: string): string {
  return key.split(".").pop()?.replace(/_/g, " ") ?? key;
}

function SegmentedControl({
  value,
  onChange,
  disabled,
}: {
  value: Decision;
  onChange: (v: Decision) => void;
  disabled?: boolean;
}) {
  const opts: Decision[] = ["auto", "propose", "off"];
  const colors: Record<Decision, string> = {
    auto: "var(--auto)",
    propose: "var(--propose)",
    off: "var(--off)",
  };

  return (
    <div
      style={{
        display: "inline-flex",
        gap: 2,
        background: "var(--surface-2)",
        borderRadius: 6,
        padding: 2,
      }}
    >
      {opts.map((opt) => (
        <button
          key={opt}
          onClick={() => !disabled && onChange(opt)}
          disabled={disabled}
          style={{
            padding: "4px 12px",
            borderRadius: 4,
            border: "none",
            background: value === opt ? colors[opt] : "transparent",
            color: value === opt ? "#fff" : "var(--text-secondary)",
            fontSize: 11,
            fontWeight: 600,
            cursor: disabled ? "not-allowed" : "pointer",
            transition: "background 0.12s, color 0.12s",
            opacity: disabled ? 0.5 : 1,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

export default function PermissionsPage() {
  const [data, setData] = useState<PoliciesResponse | null>(null);
  const [pending, setPending] = useState<Record<string, Decision>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const { prefix } = useProject();

  const load = useCallback(() => {
    fetch(prefix("/api/policies"))
      .then((r) => r.json())
      .then((d) => {
        setData(d as PoliciesResponse);
        setPending({});
      })
      .catch(() => setError("Failed to load policies"));
  }, [prefix]);

  useEffect(() => { load(); }, [load]);

  async function handleChange(key: string, value: Decision) {
    // Optimistic update
    setPending((p) => ({ ...p, [key]: value }));
    setSaving((s) => ({ ...s, [key]: true }));
    try {
      const res = await fetch(prefix("/api/policies"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      const d = await res.json() as PoliciesResponse;
      if (res.ok) {
        setData(d);
        setPending((p) => {
          const next = { ...p };
          delete next[key];
          return next;
        });
      } else {
        // Revert optimistic
        setPending((p) => {
          const next = { ...p };
          delete next[key];
          return next;
        });
        setError(`Failed to update ${key}`);
      }
    } catch {
      setPending((p) => {
        const next = { ...p };
        delete next[key];
        return next;
      });
      setError("Network error");
    } finally {
      setSaving((s) => ({ ...s, [key]: false }));
    }
  }

  const effective = (key: string): Decision =>
    pending[key] ?? data?.effective[key] ?? "off";

  return (
    <Shell>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: "var(--text-primary)" }}>
          Permissions
        </h1>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>
          Toggle auto / propose / off for each classification. Changes persist immediately.
        </p>
      </div>

      {error && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 7,
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.2)",
            color: "var(--error)",
            fontSize: 12,
            marginBottom: 18,
          }}
        >
          {error}
          <button
            onClick={() => { setError(""); load(); }}
            style={{ marginLeft: 12, fontSize: 11, color: "var(--accent-hover)", background: "none", border: "none", cursor: "pointer" }}
          >
            Retry
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
        {(["auto", "propose", "off"] as const).map((v) => {
          const colors: Record<Decision, string> = { auto: "var(--auto)", propose: "var(--propose)", off: "var(--text-muted)" };
          const descs: Record<Decision, string> = {
            auto: "Execute action immediately",
            propose: "DM controller for approval",
            off: "Suppress this classification",
          };
          return (
            <div
              key={v}
              style={{
                padding: "8px 14px",
                borderRadius: 7,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: colors[v],
                }}
              />
              <span style={{ fontSize: 11, fontWeight: 700, color: colors[v], textTransform: "uppercase" }}>{v}</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{descs[v]}</span>
            </div>
          );
        })}
      </div>

      {!data ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading policies...</div>
      ) : (
        Object.entries(SOURCE_GROUPS).map(([group, keys]) => (
          <div
            key={group}
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              marginBottom: 16,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "12px 20px",
                borderBottom: "1px solid var(--border)",
                fontSize: 12,
                fontWeight: 500,
                color: "var(--text-secondary)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              {group}
            </div>
            {keys.map((key, i) => {
              const isLast = i === keys.length - 1;
              const isSensitive = key.endsWith(".sensitive");
              const val = effective(key);
              const changed = !!pending[key];
              return (
                <div
                  key={key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "12px 20px",
                    borderBottom: isLast ? "none" : "1px solid var(--border)",
                    opacity: isSensitive ? 0.5 : 1,
                  }}
                >
                  <div>
                    <span
                      style={{
                        fontSize: 13,
                        color: "var(--text-primary)",
                        fontWeight: changed ? 600 : 400,
                      }}
                    >
                      {classificationLabel(key)}
                    </span>
                    {isSensitive && (
                      <span
                        style={{
                          marginLeft: 8,
                          fontSize: 10,
                          padding: "1px 6px",
                          borderRadius: 3,
                          background: "rgba(239,68,68,0.1)",
                          color: "var(--error)",
                          fontWeight: 600,
                        }}
                      >
                        HARDCODED OFF
                      </span>
                    )}
                    {saving[key] && (
                      <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text-muted)" }}>saving...</span>
                    )}
                  </div>
                  <SegmentedControl
                    value={val}
                    onChange={(v) => handleChange(key, v)}
                    disabled={isSensitive || saving[key]}
                  />
                </div>
              );
            })}
          </div>
        ))
      )}
    </Shell>
  );
}
