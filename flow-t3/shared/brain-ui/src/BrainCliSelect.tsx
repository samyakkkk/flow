export function BrainCliSelect({ value, clis, disabled, onChange }: {
  value: string;
  clis: readonly { id: string; installed: boolean }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return <select aria-label="Primary indexing CLI" className="flow-brain-cli-select" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    {clis.map((cli) => <option key={cli.id} value={cli.id} disabled={!cli.installed}>
      {cli.id === "claude" ? "Claude Code" : cli.id === "codex" ? "Codex" : "OpenCode"}{!cli.installed ? " — not installed" : ""}
    </option>)}
  </select>;
}
