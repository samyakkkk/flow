import { resolveHomeBaseDir, type JoinPath } from "@t3tools/shared/homeBaseDir";
import * as Option from "effect/Option";

export type { JoinPath };

function normalizeConfiguredBaseDir(t3Home: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(t3Home)) {
    return Option.none();
  }
  const trimmed = t3Home.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

/**
 * `legacyHomeExists` answers "does `~/.t3/userdata` exist" — see
 * `@t3tools/shared/homeBaseDir`. It is an input rather than a filesystem read
 * because this runs before Electron is ready, on both callers' behalf.
 */
export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
  readonly legacyHomeExists: boolean;
}): string {
  return resolveHomeBaseDir({
    explicit: Option.getOrUndefined(normalizeConfiguredBaseDir(input.t3Home)),
    homeDirectory: input.homeDirectory,
    joinPath: input.joinPath,
    legacyHomeExists: input.legacyHomeExists,
  });
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.t3Home));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
