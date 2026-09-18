// Which Repository node a session means. Sessions name their repo loosely — a
// GitHub `owner/repo` label, a bare folder name, sometimes a remote URL — while
// the graph names it after the registered source, and the two drift (a source
// added from a local path is registered bare; its checkout's origin gives
// `owner/repo`). Matching on the exact string made a fully indexed graph report
// "not indexed". The git remote is the stable identity, so match on that first.

/** Canonical `host/owner/repo` for a remote URL, lowercased with no `.git`.
    Same key as `normalizeRemote` in flow-t3/shared/bin/harness/resolve.mjs,
    which is what folder-to-Brain resolution uses; keep the two identical. */
export function canonicalRemote(value: string | null | undefined): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  if (!normalized) return "";
  if (/^(?:ssh|https?|git):\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      const path = url.pathname.split("/").filter(Boolean).join("/");
      if (url.hostname && path.includes("/")) return `${url.hostname}/${path}`;
    } catch {
      return normalized;
    }
  }
  const scp = /^[a-zA-Z0-9._-]+@([^:/\s]+):([^/\s]+(?:\/[^/\s]+)+)$/i.exec(normalized);
  if (scp?.[1] && scp[2]) return `${scp[1]}/${scp[2]}`;
  return normalized;
}

export interface RepositoryRow {
  readonly id: string;
  readonly name?: string | null;
  readonly remote?: string | null;
  readonly description?: string | null;
}

const lastSegment = (value: string) => value.split("/").filter(Boolean).at(-1) ?? "";
const bareName = (row: RepositoryRow) =>
  lastSegment(canonicalRemote(row.name || row.id.replace(/^repo:/, "")));

/**
 * The Repository node a session's `repo` refers to, most certain match first:
 * the exact name or id; the stored git remote (a label `owner/repo` matches
 * `github.com/owner/repo`); then the same repository name when only one node
 * has it. A name two nodes share is never guessed between, and a session in a
 * repository the graph does not hold gets no match rather than a neighbour's
 * description — an agent told it is in the wrong repository is worse off than
 * one told nothing. Only a session that names no repository gets the first.
 */
export function matchRepository<T extends RepositoryRow>(
  requested: string,
  rows: readonly T[],
): T | undefined {
  if (!requested) return rows[0];
  const exact = rows.find((row) => row.name === requested || row.id === `repo:${requested}`);
  if (exact) return exact;

  const wanted = canonicalRemote(requested);
  const byRemote = rows.filter((row) => {
    const remote = canonicalRemote(row.remote);
    return remote && (remote === wanted || remote.endsWith(`/${wanted}`));
  });
  if (byRemote.length === 1) return byRemote[0];

  // Also covers graphs indexed before remotes were stamped: `owner/repo` and a
  // bare `repo` name the same repository when nothing else shares that name.
  const byName = rows.filter(
    (row) =>
      canonicalRemote(row.name || "") === wanted ||
      canonicalRemote(row.name || "").endsWith(`/${wanted}`) ||
      wanted.endsWith(`/${canonicalRemote(row.name || "")}`) ||
      bareName(row) === lastSegment(wanted),
  );
  return byName.length === 1 ? byName[0] : undefined;
}
