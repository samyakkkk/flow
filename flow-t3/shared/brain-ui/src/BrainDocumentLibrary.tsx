import { useEffect, useState, type ReactNode } from "react";
import { BookOpenIcon, ChevronDownIcon, FileCode2Icon, SearchIcon, XIcon } from "lucide-react";
import type { BrainUiDocument, BrainUiDocumentSummary } from "./types.ts";

export function documentLifecycle(document: BrainUiDocumentSummary): string {
  if (document.status === "resolved") return "Resolved · lesson retained";
  if (document.lifecycle === "temporal") return "Time-sensitive context";
  if (document.lifecycle === "issue") return "Open issue";
  return document.kind === "skill" ? "Reusable procedure" : document.kind === "doc" ? "Maintained context" : "Retained memory";
}

export function BrainDocumentLibrary({
  documents,
  kind,
  loadDocument,
  renderContent,
}: {
  readonly documents: readonly BrainUiDocumentSummary[];
  readonly kind: "doc" | "skill";
  readonly loadDocument?: (id: string) => Promise<BrainUiDocument | null>;
  readonly renderContent?: (document: BrainUiDocument) => ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [selected, setSelected] = useState<BrainUiDocumentSummary | null>(null);
  const all = documents.filter((document) => document.kind === kind);
  const visible = all.filter((document) => `${document.name} ${document.description}`.toLowerCase().includes(query.toLowerCase()));
  const label = kind === "skill" ? "Auto-Skills" : "Auto-Docs";
  const Icon = kind === "skill" ? FileCode2Icon : BookOpenIcon;

  return (
    <>
      <label className="flow-brain-document-search">
        <SearchIcon size={16} />
        <input aria-label={`Search ${label.toLowerCase()}`} placeholder={`Search ${label.toLowerCase()}…`} value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <section className="flow-brain-document-section" aria-label={label}>
        <header>
          <Icon size={16} />
          <div>
            <h2>{label} <span>{all.length}</span></h2>
            <p>{kind === "skill" ? "Procedures your agents can find, read, and reuse." : "Maintained facts, customer context, and standing constraints."}</p>
          </div>
          <button type="button" aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
            <ChevronDownIcon className={collapsed ? "" : "expanded"} size={16} />
          </button>
        </header>
        {!collapsed && (
          <div className="flow-brain-document-grid">
            {visible.map((document) => (
              <button key={document.id} type="button" onClick={() => setSelected(document)}>
                <span><Icon size={15} /> {documentLifecycle(document)}</span>
                <strong>{document.name}</strong>
                <p>{document.description}</p>
              </button>
            ))}
            {!visible.length && <p className="flow-brain-empty-library">{query ? "No matching documents." : `No ${label.toLowerCase()} yet. They will appear as your team works in connected chats.`}</p>}
          </div>
        )}
      </section>
      {selected && (
        <BrainDocumentDialog
          document={selected}
          {...(loadDocument ? { loadDocument } : {})}
          {...(renderContent ? { renderContent } : {})}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}

function BrainDocumentDialog({
  document,
  loadDocument,
  renderContent,
  onClose,
}: {
  readonly document: BrainUiDocumentSummary;
  readonly loadDocument?: (id: string) => Promise<BrainUiDocument | null>;
  readonly renderContent?: (document: BrainUiDocument) => ReactNode;
  readonly onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<BrainUiDocument | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    if (!loadDocument) return;
    void loadDocument(document.id)
      .then((value) => {
        if (!disposed) value ? setLoaded(value) : setError("This document is no longer available.");
      })
      .catch(() => {
        if (!disposed) setError("Could not load this document. Reopen it to retry.");
      });
    return () => { disposed = true; };
  }, [document.id, loadDocument]);
  return (
    <div className="flow-brain-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="flow-brain-dialog" role="dialog" aria-modal="true" aria-labelledby="flow-brain-document-title">
        <header>
          <span>{document.kind === "skill" ? <FileCode2Icon size={16} /> : <BookOpenIcon size={16} />}{document.kind === "skill" ? "SKILL.md" : "Auto-Doc"}</span>
          <button type="button" aria-label="Close document" onClick={onClose}><XIcon size={15} /></button>
          <h2 id="flow-brain-document-title">{document.name}</h2>
          <p>{document.description}</p>
        </header>
        <div className="flow-brain-dialog-content">
          {error && <p role="alert" className="flow-brain-error">{error}</p>}
          {!loaded && !error && <p role="status">Opening document…</p>}
          {loaded && (renderContent ? renderContent(loaded) : <pre>{loaded.text}</pre>)}
        </div>
      </section>
    </div>
  );
}
