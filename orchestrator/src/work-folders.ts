// work-folders.ts — per-user WORK surfaces: the local checkouts where agent
// sessions run. Deliberately SEPARATE from repos.json (the project-global
// list of indexable sources): on a shared deployment (Flow on EC2, agents on
// each user's machine) one user's local paths must never appear in another
// user's dashboard. Keyed by owner — the dashboard session user in prod,
// "local" in local mode.

import { db } from "./db.js";
import { listWorkspaceRepos } from "./opencode.js";

export interface WorkFolder {
  owner: string;
  path: string;
  repo: string | null; // optional hint: which source this folder is a checkout of
  added_at: number;
}

const insertFolder = db.prepare(`
  INSERT INTO work_folders (owner, path, repo)
  VALUES (@owner, @path, @repo)
  ON CONFLICT(owner, path) DO UPDATE SET repo = COALESCE(excluded.repo, work_folders.repo)
`);

export function addWorkFolder(owner: string, path: string, repo?: string): void {
  insertFolder.run({ owner, path, repo: repo ?? null });
}

export function listWorkFolders(owner: string): WorkFolder[] {
  return db
    .prepare(`SELECT owner, path, repo, added_at FROM work_folders WHERE owner = ? ORDER BY added_at DESC`)
    .all(owner) as WorkFolder[];
}

export function removeWorkFolder(owner: string, path: string): void {
  db.prepare(`DELETE FROM work_folders WHERE owner = ? AND path = ?`).run(owner, path);
}

// One-time seed: registry entries that carried a localPath (the old
// project-global WORK surface) become the "local" owner's folders, so
// existing local-mode setups keep their in-place sessions. Idempotent.
export function seedWorkFoldersFromRegistry(): void {
  for (const r of listWorkspaceRepos()) {
    if (r.kind === "docs" || !r.localPath) continue;
    try {
      addWorkFolder("local", r.localPath, r.name);
    } catch {
      /* seed is best-effort */
    }
  }
}
