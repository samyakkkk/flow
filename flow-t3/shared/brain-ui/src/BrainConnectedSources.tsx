import { Folder, Github, Trash2Icon } from "lucide-react";

export interface BrainConnectedSource {
  readonly id: string;
  readonly repository: string;
  readonly status: string;
  readonly message: string;
  readonly branch?: string | undefined;
  readonly localPath?: string | undefined;
  readonly indexedAt?: string | null | undefined;
  readonly summary?: string | undefined;
  readonly activity?: { readonly filesRead: number; readonly graphWrites: number; readonly events: readonly { readonly seq: number; readonly ts: number; readonly label: string }[] } | undefined;
}
export const isBrainSourceIndexing = (status: string) => ["queued", "cloning", "indexing", "embedding"].includes(status);
const label = (status: string) => ({ embedding: "Saving", cloning: "Reading", ready: "Connected", waiting: "Needs a commit" })[status] ?? status.charAt(0).toUpperCase() + status.slice(1);

export function BrainConnectedSources({ sources, busy, onAction }: {
  sources: readonly BrainConnectedSource[];
  busy: boolean;
  onAction: (action: "cancel" | "reindex" | "removeSource", sourceId: string) => void;
}) {
  return <div className="flow-brain-connected-sources">{sources.map((source) => <article key={source.id}>
    {source.localPath ? <Folder size={16} /> : <Github size={16} />}
    <div className="flow-brain-connected-copy">
      {source.localPath ? <strong>{source.repository}</strong> : <a href={`https://github.com/${source.repository}`} target="_blank" rel="noreferrer">{source.repository}</a>}
      <p role="status">{source.message}</p>
      <p>{source.branch || "Default branch"} · {source.indexedAt ? `Last indexed ${new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(Date.parse(source.indexedAt))}` : "Not indexed yet"}</p>
      {source.localPath && <p>{source.localPath}</p>}
    </div>
    <span className="flow-brain-source-status">{label(source.status)}</span>
    <button type="button" className="flow-brain-button secondary" disabled={busy} onClick={() => onAction(isBrainSourceIndexing(source.status) ? "cancel" : "reindex", source.id)}>{isBrainSourceIndexing(source.status) ? "Cancel" : source.status === "ready" ? "Reindex" : source.status === "waiting" ? "Index" : "Retry"}</button>
    {!isBrainSourceIndexing(source.status) && <button type="button" className="flow-brain-icon-button" disabled={busy} aria-label={`Delete ${source.repository} from brain`} onClick={() => onAction("removeSource", source.id)}><Trash2Icon size={14} /></button>}
    {(isBrainSourceIndexing(source.status) || source.activity || source.summary) && <details>
      <summary>Logs{source.activity ? ` · ${source.activity.filesRead} files read · ${source.activity.graphWrites} graph writes` : ""}</summary>
      <div>{source.activity?.events.length ? source.activity.events.map((event) => <p key={event.seq}>{new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(event.ts)} · {event.label}</p>) : <p>{isBrainSourceIndexing(source.status) ? "Waiting for indexer activity…" : "No tool activity recorded for this run."}</p>}</div>
      {source.summary && !isBrainSourceIndexing(source.status) && <p>{source.summary}</p>}
    </details>}
  </article>)}</div>;
}
