// repo-family.ts — normalize a repo name into its "family".
//
// Memory retrieval hard-gates on repo_family: a memory from `acme-backend` is
// eligible for a query on `acme-frontend` (same product) but NOT for `other`.
// We strip common component suffixes so the family is the product, not the tier.
// Also strips owner prefix (owner/repo -> repo) and a trailing .git.
//
// A NULL/empty family means "match-all" (corpus rows we couldn't attribute to a
// repo) — the gate treats null as matching every query's family.

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

// Family gate: does a memory/observation with family `memFamily` match a query
// scoped to `queryFamily`? Null on EITHER side means match-all (unattributed
// corpus, or a query with no repo). Otherwise exact family equality.
export function familyMatches(queryFamily: string | null, memFamily: string | null): boolean {
  if (!queryFamily || !memFamily) return true;
  return queryFamily === memFamily;
}
