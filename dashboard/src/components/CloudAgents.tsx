"use client";
import { useState } from "react";
import { useProject } from "@/lib/useProject";

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
