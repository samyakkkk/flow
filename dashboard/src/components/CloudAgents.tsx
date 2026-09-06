"use client";
import { useEffect, useState } from "react";
import { useProject } from "@/lib/useProject";

const button = "rounded border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-40";
async function api(url: string, method = "GET", body?: unknown) {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}
export function CloudCommandPanel({ id, repos }: { id: string; repos: { name: string }[] }) {
  const { prefix } = useProject();
  const [command, setCommand] = useState("");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <details className="border-t border-line bg-cream px-4 py-2 text-xs"><summary className="cursor-pointer font-mono">Server terminal command</summary><form className="mt-3 flex flex-col gap-2" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(""); try { await api(prefix(`/api/cloud/tasks/${id}/command`), "POST", { repo: repo || repos[0]?.name, command }); setCommand(""); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }}><p className="text-text-muted">Runs in this task’s worktree under the coding queue. Noninteractive; stops after two minutes. Output appears in the transcript.</p><select aria-label="Command repository" className="rounded border border-line bg-paper p-2" value={repo || repos[0]?.name || ""} onChange={e => setRepo(e.target.value)}>{repos.map(r => <option key={r.name}>{r.name}</option>)}</select><textarea aria-label="Server command" className="rounded border border-line bg-paper p-2 font-mono" value={command} onChange={e => setCommand(e.target.value)} placeholder="npm test" /><button className="self-start rounded border border-line bg-paper px-3 py-1" disabled={busy || !command.trim() || !repos.length}>Run command</button>{error && <p role="alert">{error}</p>}</form></details>;
}
export function RepoEnvPanel({ repo }: { repo: string }) {
  const { prefix } = useProject();
  const url = prefix(`/api/cloud/repos/${encodeURIComponent(repo)}/env`);
  const [files, setFiles] = useState<{ filename: string; updatedAt: number }[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (open) void api(url).then(d => setFiles(d.files)).catch(e => setError(e.message)); }, [url, open]);
  async function change(method: string, filename: string, content?: string) { setBusy(true); setError(""); try { setFiles((await api(url, method, { filename, content })).files); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <details className="border-t border-[var(--line)] px-3 py-3" onToggle={e => setOpen(e.currentTarget.open)}><summary className="cursor-pointer text-xs">Environment files</summary><div className="mt-3 space-y-3"><p className="text-xs text-[var(--text-muted)]">Upload .env or .env.local for {repo}. Stored encrypted on this server and copied only into this repo’s task worktrees at the next turn. Values are never displayed here. Applications load these files themselves.</p><label className="block text-xs">Upload or replace an env file<input aria-label={`Upload env file for ${repo}`} type="file" className="mt-2 block text-xs" disabled={busy} onChange={async e => { const file = e.target.files?.[0]; e.target.value = ""; if (!file) return; if (file.size > 256 * 1024) { setError("Maximum file size is 256 KiB"); return; } await change("PUT", file.name, await file.text()); }} /></label>{files.map(file => <div className="flex items-center justify-between text-xs" key={file.filename}><span>{file.filename} · {new Date(file.updatedAt).toLocaleString()}</span><button className={button} disabled={busy} onClick={() => void change("DELETE", file.filename)}>Remove</button></div>)}{error && <p role="alert" className="text-xs">{error}</p>}</div></details>;
}
