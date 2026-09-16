import { useState } from "react";
import type { EnvironmentId, FilesystemBrowseResult } from "@t3tools/contracts";
import { ArrowUpIcon, ChevronRightIcon, FolderIcon, GithubIcon } from "lucide-react";
import { filesystemEnvironment } from "../../state/filesystem";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

export function ProjectSourcePicker({
  environmentId,
  disabled,
  onFolder,
  onGithub,
}: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly onFolder: (path: string) => Promise<void>;
  readonly onGithub: (repository: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"folder" | "github">("folder");
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<FilesystemBrowseResult | null>(null);
  const [path, setPath] = useState("~");
  const [repository, setRepository] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const browse = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    refresh: true,
  });
  const openFolder = async (folder: string) => {
    setBusy(true);
    setError("");
    try {
      const result = await browse({
        environmentId,
        input: { partialPath: folder.endsWith("/") ? folder : folder + "/" },
      });
      if (result._tag !== "Success") {
        setError("Could not open this folder. Choose another location.");
        return;
      }
      setListing(result.value);
      setPath(result.value.parentPath);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() => {
            setMode("folder");
            setOpen(true);
            void openFolder(path);
          }}
        >
          <FolderIcon className="size-4" />
          Choose folder
        </Button>
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() => {
            setError("");
            setMode("github");
            setOpen(true);
          }}
        >
          <GithubIcon className="size-4" />
          Add GitHub repository
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(open) => {
          if (!open && !busy) setOpen(false);
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {mode === "folder" ? "Choose a project folder" : "Add a GitHub repository"}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            {mode === "folder" ? (
              <>
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void openFolder(path);
                  }}
                >
                  <Input
                    aria-label="Folder location"
                    value={path}
                    disabled={busy}
                    onChange={(event) => setPath(event.target.value)}
                  />
                  <Button variant="outline" type="submit" disabled={busy || !path.trim()}>
                    Go
                  </Button>
                </form>
                <p className="text-xs text-muted-foreground">
                  Choose a project, or a parent folder containing several projects.
                </p>
                <div className="max-h-64 overflow-auto rounded-lg border">
                  {listing ? (
                    <>
                      <Button
                        variant="ghost"
                        className="w-full justify-start"
                        disabled={busy}
                        onClick={() =>
                          void openFolder(
                            listing.parentPath.replace(/[/\\][^/\\]+[/\\]?$/, "") || "/",
                          )
                        }
                      >
                        <ArrowUpIcon className="size-4" />
                        Parent folder
                      </Button>
                      {listing.entries
                        .filter((entry) => !entry.name.startsWith("."))
                        .map((entry) => (
                          <button
                            type="button"
                            key={entry.fullPath}
                            disabled={busy}
                            className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                            onClick={() => void openFolder(entry.fullPath)}
                          >
                            <FolderIcon className="size-4" />
                            <span className="flex-1 text-left">{entry.name}</span>
                            <ChevronRightIcon className="size-4" />
                          </button>
                        ))}
                    </>
                  ) : (
                    <p className="p-3 text-sm text-muted-foreground">
                      {busy ? "Opening folders…" : "Choose a folder location above."}
                    </p>
                  )}
                </div>
              </>
            ) : (
              <label className="block space-y-2 text-sm">
                GitHub URL
                <Input
                  autoFocus
                  value={repository}
                  disabled={busy}
                  placeholder="https://github.com/team/project"
                  onChange={(event) => setRepository(event.target.value)}
                />
              </label>
            )}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                busy ||
                (mode === "folder" ? !listing || path !== listing.parentPath : !repository.trim())
              }
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  if (mode === "folder" && listing) await onFolder(listing.parentPath);
                  else await onGithub(repository.trim());
                  setRepository("");
                  setOpen(false);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : "Could not add repository.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Working…" : mode === "folder" ? "Choose this folder" : "Add repository"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
