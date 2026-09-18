import { useEffect, useState, type ReactNode } from "react";

export interface BrainRepository {
  readonly name: string;
  readonly description?: string | undefined;
  readonly private: boolean;
  readonly defaultBranch?: string | undefined;
}

/** Presentation and selection state only. Hosts own credentials, transport, and import commands. */
export function BrainRepositoryPicker({ connectedRepositories, connection, loadRepositories, loadBranches, connect, onConnected, autoBrowse = false }: {
  connectedRepositories: readonly string[];
  connection: ReactNode;
  loadRepositories: () => Promise<readonly BrainRepository[]>;
  loadBranches: (repository: string) => Promise<readonly string[]>;
  connect: (repository: string, branch?: string) => Promise<void>;
  onConnected: () => void;
  /** List repositories on open, for hosts whose credential already scopes the list (a GitHub App installation). */
  autoBrowse?: boolean;
}) {
  const [repositories, setRepositories] = useState<readonly BrainRepository[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("");
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<Record<string, readonly string[]>>({});
  const [branchLoading, setBranchLoading] = useState<Record<string, boolean>>({});
  const [branchErrors, setBranchErrors] = useState<Record<string, string>>({});
  const [completed, setCompleted] = useState<string[]>([]);
  const connected = (name: string) => [...connectedRepositories, ...completed].some((entry) => entry.toLowerCase() === name.toLowerCase());
  async function browse() {
    setLoading(true); setError("");
    try { setRepositories(await loadRepositories()); setLoaded(true); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not load repositories."); }
    finally { setLoading(false); }
  }
  async function branches(name: string) {
    setBranchLoading((value) => ({ ...value, [name]: true }));
    setBranchErrors((value) => ({ ...value, [name]: "" }));
    try { setOptions((value) => ({ ...value, [name]: [] })); const result = await loadBranches(name); setOptions((value) => ({ ...value, [name]: result })); }
    catch (error) { setBranchErrors((value) => ({ ...value, [name]: error instanceof Error ? error.message : "Could not load branches." })); }
    finally { setBranchLoading((value) => ({ ...value, [name]: false })); }
  }
  async function submit(entries: [string, string][]) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      for (const [name, branch] of entries) {
        await connect(name.trim(), branch || undefined);
        setCompleted((value) => [...value, name]);
        setSelected((value) => { const next = { ...value }; delete next[name]; return next; });
      }
      onConnected();
    } catch (error) { setError(error instanceof Error ? error.message : "Could not connect the repository. Retry."); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (autoBrowse) void browse(); }, [autoBrowse]);
  const visible = repositories.filter((repo) => repo.name.toLowerCase().includes(query.toLowerCase()));
  return <div className="flow-brain-repository-picker" aria-busy={busy}>
    <form className="flow-brain-repository-form" onSubmit={(event) => { event.preventDefault(); void submit([[repository, branch]]); }}>
      <label>Repository URL<input required value={repository} onChange={(event) => setRepository(event.target.value)} placeholder="owner/repo or GitHub URL" disabled={busy} /></label>
      <label>Branch<input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="Default branch" disabled={busy} /></label>
      <button className="flow-brain-button primary" disabled={busy || !repository.trim()}>Connect</button>
    </form>
    <div className="flow-brain-repository-connection">{connection}<button type="button" className="flow-brain-button outline" disabled={loading || busy} onClick={() => void browse()}>{loading ? "Loading repositories…" : "Browse repositories"}</button></div>
    {error && <p role="alert" className="flow-brain-error">{error}</p>}
    {loading && <p role="status">Loading repositories…</p>}
    {loaded && !loading && !repositories.length && <p>No repositories found for this account.</p>}
    {repositories.length > 0 && <>
      <input aria-label="Search GitHub repositories" placeholder="Search repositories…" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="flow-brain-repository-results">
        {visible.map((repo) => <article key={repo.name}>
          <label className="flow-brain-repository-choice"><input type="checkbox" disabled={busy || connected(repo.name)} checked={connected(repo.name) || repo.name in selected} onChange={(event) => {
            if (event.target.checked) { setSelected((value) => ({ ...value, [repo.name]: repo.defaultBranch || "" })); if (!options[repo.name]) void branches(repo.name); }
            else setSelected((value) => { const next = { ...value }; delete next[repo.name]; return next; });
          }} /><span>{repo.name}</span><small>{connected(repo.name) ? "Connected" : repo.private ? "Private" : "Public"}</small></label>
          {repo.description && <p>{repo.description}</p>}
          {repo.name in selected && !connected(repo.name) && <label>Branch
            <select aria-label={`Branch for ${repo.name}`} disabled={busy || branchLoading[repo.name]} value={selected[repo.name]} onChange={(event) => setSelected((value) => ({ ...value, [repo.name]: event.target.value }))}>
              {[...new Set([repo.defaultBranch || "", ...(options[repo.name] || [])])].map((value) => <option key={value} value={value}>{value || "Default branch"}{value && value === repo.defaultBranch ? " (default)" : ""}</option>)}
            </select>
            {branchLoading[repo.name] && <small role="status">Loading branches…</small>}
            {branchErrors[repo.name] && <span role="alert">{branchErrors[repo.name]} <button type="button" className="flow-brain-button outline" onClick={() => void branches(repo.name)}>Retry</button></span>}
          </label>}
        </article>)}
        {!visible.length && <p>No repositories match your search.</p>}
      </div>
    </>}
    {Object.keys(selected).length > 0 && <footer><button type="button" className="flow-brain-button primary" disabled={busy || Object.entries(branchLoading).some(([name, loading]) => name in selected && loading)} onClick={() => void submit(Object.entries(selected))}>{busy ? "Connecting…" : `Connect ${Object.keys(selected).length} repositories`}</button></footer>}
  </div>;
}
