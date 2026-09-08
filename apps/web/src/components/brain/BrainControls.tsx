import { useState, type ReactNode } from "react";
import type { BrainCli, BrainState, BrainCommand, BrainResponse } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

export type SendBrainCommand = (
  command: BrainCommand,
  background?: boolean,
) => Promise<BrainResponse | null>;
export const cliName = (cli: BrainCli) =>
  cli === "claude" ? "Claude Code" : cli === "codex" ? "Codex" : "OpenCode";

export function BrainSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string; icon?: ReactNode; disabled?: boolean }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <Select
      value={value}
      items={options}
      onValueChange={(next) => next !== null && onChange(next)}
      disabled={disabled}
    >
      <SelectTrigger aria-label={label} className="w-auto min-w-40 max-w-full">
        <SelectValue placeholder={label}>
          {selected?.icon ? (
            <span className="flex min-w-0 items-center gap-2">
              {selected.icon}
              <span className="truncate">{selected.label}</span>
            </span>
          ) : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
            <span className="flex min-w-0 items-center gap-2">
              {option.icon}
              <span className="truncate">{option.label}</span>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function CreateBrainDialog({
  open,
  onOpenChange,
  state,
  send,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: BrainState | null;
  send: SendBrainCommand;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [cli, setCli] = useState<BrainCli | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = cli ?? state?.clis.find((entry) => entry.installed)?.id;
  async function create() {
    if (!selected || busy || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await send({ action: "create", name, cli: selected });
      if (!result || result.error || !result.createdWorkspaceId) {
        setError(result?.error ?? "Could not create the brain. Check the connection and retry.");
        return;
      }
      onCreated(result.createdWorkspaceId);
      onOpenChange(false);
      setName("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogPopup className="max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <DialogHeader>
            <DialogTitle>Create a brain</DialogTitle>
            <DialogDescription>
              Connect sources to build shared knowledge for your projects.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-5">
            <label className="block space-y-2 text-sm">
              Brain name
              <Input
                autoFocus
                required
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Acme platform"
              />
            </label>
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm">Build knowledge with</legend>
              {state?.clis.map((entry) => (
                <label
                  key={entry.id}
                  className={`flex items-center gap-3 rounded-lg border p-3 text-sm ${!entry.installed ? "opacity-50" : selected === entry.id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}`}
                >
                  <input
                    type="radio"
                    name="brain-cli"
                    checked={selected === entry.id}
                    disabled={!entry.installed || busy}
                    onChange={() => setCli(entry.id)}
                  />
                  <span>
                    <span className="block font-medium">{cliName(entry.id)}</span>
                    <span className="text-xs text-muted-foreground">
                      {entry.installed
                        ? "Uses your existing CLI sign-in"
                        : "Not installed on this computer"}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || !selected}>
              {busy ? "Creating…" : "Create brain"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
