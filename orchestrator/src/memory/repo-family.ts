// repo-family.ts — normalize a repo name into its "family".
//
// repo_family is a RANKING affinity, not a gate: a memory from `acme-backend`
// ranks above rest-of-project memories for a query from `acme-frontend` (same
// product), but nothing in the project is ever filtered out — the project is
// the trust boundary (one flow.db per project), so all repos share memories.
// We strip common component suffixes so the family is the product, not the
// tier. Also strips owner prefix (owner/repo -> repo) and a trailing .git.
// A NULL/empty family (corpus rows we couldn't attribute to a repo) simply
// earns no affinity boost.

const SUFFIXES = [
  "backend",
  "frontend",
  "api",
  "server",
  "client",
  "web",
  "app",
  "service",
  "svc",
  "ui",
  "worker",
  "core",
  "lib",
  "sdk",
  "infra",
  "mobile",
];

export function repoFamily(repo: string | null | undefined): string | null {
  if (!repo) return null;
  let name = String(repo).trim().toLowerCase();
  if (!name) return null;
  // owner/repo -> repo
  const slash = name.lastIndexOf("/");
  if (slash >= 0) name = name.slice(slash + 1);
  // trailing .git
  name = name.replace(/\.git$/, "");
  // strip ONE trailing component suffix separated by - or _
  for (const s of SUFFIXES) {
    const re = new RegExp(`[-_]${s}$`);
    if (re.test(name)) {
      name = name.replace(re, "");
      break;
    }
  }
  return name || null;
}
