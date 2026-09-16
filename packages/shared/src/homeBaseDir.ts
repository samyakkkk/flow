/**
 * Which directory under `$HOME` a T3 base dir defaults to.
 *
 * Existing installs are adopted where they already are: their data lives in
 * `~/.t3` and is never moved. Moving it would orphan the FalkorDB store (its
 * directory is a hash of the absolute brain path), break every managed git
 * worktree's absolute `gitdir:` pointer, and re-key the hook project ids that
 * are derived from the state directory. Fresh installs get `~/.flow`, the Flow
 * agent registry's home, whose entries do not collide with a T3 base dir.
 *
 * "Existing" is decided by `~/.t3/userdata`, the state directory a real install
 * always has. Callers pass the answer in rather than the rule doing the I/O:
 * each site has a different filesystem story (Effect `FileSystem`, Electron's
 * pre-ready sync reads, plain Node scripts) and tests need it deterministic.
 *
 * Unrelated to the repo-local worktree `.t3` convention in `./devHome.ts`.
 */

export type JoinPath = (first: string, ...segments: string[]) => string;

export const LEGACY_BASE_DIR_NAME = ".t3";
export const DEFAULT_BASE_DIR_NAME = ".flow";

/** The path whose existence means "an install already lives at `~/.t3`". */
export const legacyBaseDirProbePath = (homeDirectory: string, joinPath: JoinPath): string =>
  joinPath(homeDirectory, LEGACY_BASE_DIR_NAME, "userdata");

/**
 * The base dir to use: an explicit selection (`T3CODE_HOME`, `--base-dir`) wins,
 * then the adopted legacy home, then the fresh-install default. The explicit
 * value is returned verbatim apart from trimming; resolving `~` or relative
 * paths belongs to the caller that knows its own cwd.
 */
export const resolveHomeBaseDir = (input: {
  readonly explicit: string | undefined;
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly legacyHomeExists: boolean;
}): string => {
  const explicit = input.explicit?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  return input.joinPath(
    input.homeDirectory,
    input.legacyHomeExists ? LEGACY_BASE_DIR_NAME : DEFAULT_BASE_DIR_NAME,
  );
};
