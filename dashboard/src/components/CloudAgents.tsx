"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useProject } from "@/lib/useProject";
import { MarkdownContent } from "./Markdown";

interface Turn { id: string; status: string; phase: string; message: string; command: boolean; result?: { answer_md: string; output: string; exit_code?: number }; events: { title: string; output?: string; status?: string }[] }
interface Repo { name: string; worktree?: { path: string; branch: string; archived_at?: number; cleanup_error?: string } }
const box = "rounded-lg border border-[var(--line)] bg-[var(--paper)] p-4";
const button = "rounded border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-40";
const input = "w-full rounded border border-[var(--line)] bg-transparent p-3 text-sm";
async function api(url: string, method = "GET", body?: unknown) {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}
export function CloudAgentsView() {
  const { prefix } = useProject();
  const router = useRouter();
  const url = prefix("/api/cloud/tasks");
  const [tasks, setTasks] = useState<Turn[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; const refresh = () => api(url).then(d => { if (active) { setTasks(d.tasks); setError(""); } }).catch(e => { if (active) setError(e.message); }); void refresh(); const timer = setInterval(refresh, 3000); return () => { active = false; clearInterval(timer); }; }, [url]);
  return <div className="mx-auto max-w-4xl space-y-6 p-6">
    <div><p className="text-xs uppercase tracking-widest">Server agents</p><h1 className="mt-2 font-serif text-3xl">Engineering tasks</h1><p className="mt-2 text-sm text-[var(--text-muted)]">Slack threads and dashboard tasks share this worker. One coding task runs at a time; questions can run alongside it.</p></div>
    <form className={`${box} space-y-3`} onSubmit={async e => { e.preventDefault(); setBusy(true); setError(""); try { const job = await api(url, "POST", { message, conversation: { source: "dashboard", id: crypto.randomUUID() } }); router.push(prefix(`/agents/cloud-${job.id}`)); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }}>
      <label htmlFor="cloud-task" className="text-sm font-medium">Give Flow a task</label><textarea id="cloud-task" required className={input} rows={3} value={message} onChange={e => setMessage(e.target.value)} placeholder="Fix a bug, investigate a question, or run tests…" /><button className={button} disabled={busy || !message.trim()}>Start task</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {!tasks.length && <p className="text-sm">No cloud tasks yet.</p>}
    {tasks.map(task => <Link className={`${box} block`} href={prefix(`/agents/cloud-${task.id}`)} key={task.id}><span className="text-xs uppercase tracking-wide">{task.phase}</span><p className="mt-2 line-clamp-2">{task.message}</p><span className="mt-3 block text-xs text-[var(--text-muted)]">Open conversation →</span></Link>)}
  </div>;
}
export function CloudTaskRun({ id }: { id: string }) {
  const { prefix } = useProject();
  const url = prefix(`/api/cloud/tasks/${id}`);
  const [data, setData] = useState<{ turns: Turn[]; repos: Repo[]; slackUrl?: string }>();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [command, setCommand] = useState("");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; const refresh = () => api(url).then(d => { if (active) setData(d); }).catch(e => { if (active) setError(e.message); }); void refresh(); const timer = setInterval(refresh, 2000); return () => { active = false; clearInterval(timer); }; }, [url]);
  async function send(action: string, body: unknown, job = id) { setBusy(true); setError(""); try { await api(prefix(`/api/cloud/tasks/${job}/${action}`), "POST", body); setData(await api(url)); if (action === "followup") setMessage(""); if (action === "command") setCommand(""); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <div className="mx-auto max-w-5xl space-y-5 p-6">
    <Link className="text-sm" href={prefix("/agents")}>← Agents</Link><h1 className="font-serif text-3xl">Cloud conversation</h1>
    {data?.slackUrl && <a className="text-sm underline" href={data.slackUrl} target="_blank" rel="noreferrer">Open Slack thread</a>}
    {error && <p role="alert">{error}</p>}{!data && !error && <p>Loading run…</p>}
    {data?.repos.filter(r => r.worktree).map(r => <div className={box} key={r.name}><strong>{r.name}</strong><p className="mt-1 break-all font-mono text-xs">{r.worktree!.branch} · {r.worktree!.archived_at ? "Checkpointed; restores on next turn" : r.worktree!.path}</p>{r.worktree!.cleanup_error && <p className="mt-2 text-sm">Cleanup retained this workspace: {r.worktree!.cleanup_error}</p>}</div>)}
    {data?.turns.map(turn => <article className={`${box} space-y-3`} key={turn.id}>
      <div className="flex items-center justify-between"><span className="text-xs uppercase tracking-wide">{turn.command ? "Command" : "Agent"} · {turn.phase}</span>{["queued", "running"].includes(turn.status) && <button className={button} disabled={busy} onClick={() => void send("cancel", {}, turn.id)}>Cancel</button>}</div>
      <p className="whitespace-pre-wrap text-sm">{turn.message}</p>
      {turn.events?.length > 0 && <details><summary className="cursor-pointer text-sm">Activity · {turn.events.length} events</summary><div className="mt-3 max-h-96 space-y-3 overflow-auto">{turn.events.map((event, i) => <div key={i} className="border-l-2 border-[var(--line)] pl-3"><p className="whitespace-pre-wrap break-words font-mono text-xs">{event.status} {event.title}</p>{event.output && <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{event.output}</pre>}</div>)}</div></details>}
      {turn.result?.answer_md && <MarkdownContent md={turn.result.answer_md} />}
      {turn.result?.output && <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--line)] p-3 text-xs">{turn.result.output}</pre>}
      {turn.result?.exit_code !== undefined && <p className="text-xs">Exit status: {turn.result.exit_code}</p>}
    </article>)}
    <form className={`${box} space-y-3`} onSubmit={e => { e.preventDefault(); void send("followup", { message }); }}><label htmlFor="followup" className="text-sm font-medium">Continue this task</label><textarea id="followup" className={input} required rows={3} value={message} onChange={e => setMessage(e.target.value)} /><p className="text-xs text-[var(--text-muted)]">Keeps the same conversation and worktrees. Dashboard replies appear here.</p><button className={button} disabled={busy || !message.trim()}>Send follow-up</button></form>
    <details className={box}><summary className="cursor-pointer font-medium">Run a server command</summary><form className="mt-4 space-y-3" onSubmit={e => { e.preventDefault(); void send("command", { repo: repo || data?.repos[0]?.name, command }); }}><p className="text-sm text-[var(--text-muted)]">Runs in this task’s repository worktree, using the coding queue. Commands stop after two minutes. Interactive prompts and persistent servers are not supported.</p><label className="block text-sm">Repository<select className={`${input} mt-1`} value={repo || data?.repos[0]?.name || ""} onChange={e => setRepo(e.target.value)}>{data?.repos.map(r => <option key={r.name}>{r.name}</option>)}</select></label><label className="block text-sm">Command<textarea className={`${input} mt-1 font-mono`} required rows={3} value={command} onChange={e => setCommand(e.target.value)} placeholder="npm test" /></label><button className={button} disabled={busy || !command.trim() || !data?.repos.length}>Run command</button></form></details>
  </div>;
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
