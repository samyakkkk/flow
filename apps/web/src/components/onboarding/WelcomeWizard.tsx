import { ProjectSourcePicker } from "./ProjectSourcePicker";
import { Tabs } from "@base-ui/react/tabs";
import { buildProviderInstanceUpdatePatch } from "../settings/SettingsPanels.logic";
import { BRAND } from "@t3tools/shared/branding";
import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import type {
  AgentSessionProjectCandidate,
  BrainCli,
  BrainState,
  EnvironmentId,
  ProjectId,
  ScopedProjectRef,
  ServerConfig,
  ServerProvider,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CommandId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronRightIcon,
  CloudIcon,
  CopyIcon,
  FolderIcon,
  GitBranchIcon,
  LinkIcon,
  MonitorIcon,
  TerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { brainCommand } from "../../state/brain";
import { connectCloudCommand, connectCloudOutcome, connectCloudReady } from "../brain/connectCloud";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { useCompleteOnboarding } from "../../onboarding/firstRun";
import {
  projectIsWithinFolder,
  isSuggestedBrainProject,
  folderMatchesRemoteSource,
  githubRepositoryKey,
  matchGithubProjects,
  matchRemoteBrainSources,
  onboardingProjectKey,
  resolveOnboardingLandingProject,
  resolveOnboardingProjectId,
} from "../../onboarding/projectImport.logic";
import {
  getOnboardingProviderState,
  resolveOnboardingProviderInstallCommand,
  resolveOnboardingProviderLoginCommand,
  selectOnboardingProvidersByDriver,
} from "../../onboarding/providerReadiness.logic";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { newProjectId, randomUUID } from "../../lib/utils";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { agentSessionScan, agentSessionImport } from "../../state/agentSessions";
import { readProjects, useProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { isOnboardingRelayEnvironment } from "../../onboarding/targetEnvironment.logic";
import { useProjectScans } from "../../onboarding/useProjectScans";
import { projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectPairing } from "../../connection/onboarding";
import { getProviderSummary } from "../settings/providerStatus";
import { getDriverOption } from "../settings/providerDriverMeta";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";
import { BrandWordmark } from "../BrandWordmark";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { WizardPanel, WizardSteps } from "../ui/wizard";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { cn } from "../../lib/utils";

/**
 * First-run welcome wizard. Rendered over the workspace at `/welcome` on a
 * fresh install (no completed-onboarding flag, empty workspace). Flow per the
 * onboarding overhaul spec: connection choice → sign-in/pair (remote paths) →
 * agent setup with inline install terminal → project import → main screen.
 * Every step past the connection gate is skippable; the whole wizard is
 * re-runnable by clearing the flag.
 */

type WizardStep = "connection" | "agents" | "import";

/**
 * The Brain chosen for one computer. `sources` carries a connected remote
 * Brain's indexed repositories so the Projects step can preselect their local
 * clones; a newly created local Brain has none.
 */
interface OnboardingBrainChoice {
  readonly id: string;
  readonly name: string;
  readonly sources?: readonly string[] | undefined;
}
const NO_ENVIRONMENTS: readonly EnvironmentId[] = [];

const AGENT_ONBOARDING_THREAD_ID = ThreadId.make("onboarding-agent-setup");
const ONBOARDING_STAGES = ["Connect", "Brain", "Projects"] as const;

export function WelcomeWizard({
  localAvailable,
  onDone,
}: {
  /** Whether this client is authenticated to the server serving the app. */
  readonly localAvailable: boolean;
  readonly onDone: (brain?: { environmentId: EnvironmentId; brainId: string }) => void;
}) {
  const completeOnboarding = useCompleteOnboarding();
  const [step, setStep] = useState<WizardStep>("connection");
  const { environments } = useEnvironments();
  const [selection, setSelection] = useState<ReadonlySet<EnvironmentId> | null>(null);
  const autoSelectedComputers = useRef(new Set<EnvironmentId>());
  const [setupIds, setSetupIds] = useState<readonly EnvironmentId[]>([]);
  const [projectEnvironmentIds, setProjectEnvironmentIds] = useState<readonly EnvironmentId[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [brainChoices, setBrainChoices] = useState<
    ReadonlyMap<EnvironmentId, OnboardingBrainChoice>
  >(new Map());
  const chooseOnboardingBrain = useCallback(
    (environmentId: EnvironmentId, brain: OnboardingBrainChoice) => {
      setBrainChoices((current) => new Map(current).set(environmentId, brain));
    },
    [],
  );
  const finishingPromiseRef = useRef<Promise<boolean> | null>(null);
  const completionErrorToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const primaryEnvironment = usePrimaryEnvironment();
  useEffect(() => {
    const newComputers = environments.filter(
      (environment) => !autoSelectedComputers.current.has(environment.environmentId),
    );
    if (newComputers.length === 0) return;
    for (const environment of newComputers) {
      autoSelectedComputers.current.add(environment.environmentId);
    }
    setSelection(
      (current) =>
        new Set([
          ...(current ?? []),
          ...newComputers.map((environment) => environment.environmentId),
        ]),
    );
  }, [environments]);
  const selectedIds =
    selection ?? new Set(primaryEnvironment ? [primaryEnvironment.environmentId] : []);
  const [scanRoots, setScanRoots] = useState<ReadonlyMap<EnvironmentId, readonly string[]>>(
    new Map(),
  );
  const scans = useProjectScans(
    step === "import" ? projectEnvironmentIds : NO_ENVIRONMENTS,
    scanRoots,
  );
  const isLoadingProjects =
    step === "import" &&
    scans.every((scan) => scan.data === null) &&
    scans.some((scan) => scan.isPending);
  const startSetup = (ids: readonly EnvironmentId[]) => {
    if (ids.length === 0) return;
    setSetupIds(ids);
    setStep("agents");
  };
  const stageIndex = step === "agents" ? 1 : step === "import" ? 2 : 0;
  const finish = useCallback(
    (projectRef?: ScopedProjectRef) => {
      if (finishingPromiseRef.current !== null) return finishingPromiseRef.current;
      if (completionErrorToastIdRef.current !== null) {
        toastManager.close(completionErrorToastIdRef.current);
        completionErrorToastIdRef.current = null;
      }

      const completion = completeOnboarding()
        .then(() => {
          if (completionErrorToastIdRef.current !== null) {
            toastManager.close(completionErrorToastIdRef.current);
            completionErrorToastIdRef.current = null;
          }
          const environmentId = projectRef?.environmentId ?? projectEnvironmentIds[0];
          const brain = environmentId ? brainChoices.get(environmentId) : undefined;
          onDone(environmentId && brain ? { environmentId, brainId: brain.id } : undefined);
          return true;
        })
        .catch(() => {
          const errorToast = {
            type: "error",
            title: "Could not finish setup",
            description: "Your settings could not be saved. Try again.",
          } as const;
          if (completionErrorToastIdRef.current === null) {
            completionErrorToastIdRef.current = toastManager.add(errorToast);
          } else {
            toastManager.update(completionErrorToastIdRef.current, errorToast);
          }
          return false;
        })
        .finally(() => {
          if (finishingPromiseRef.current === completion) {
            finishingPromiseRef.current = null;
          }
        });
      finishingPromiseRef.current = completion;
      return completion;
    },
    [completeOnboarding, onDone, brainChoices, projectEnvironmentIds],
  );

  return (
    <Dialog open disablePointerDismissal onOpenChange={(_, event) => event.cancel()}>
      <DialogPopup
        className="max-w-xl overflow-x-hidden overflow-y-auto"
        bottomStickOnMobile={false}
        showCloseButton={false}
        initialFocus={() => document.getElementById("onboarding-pairing-url") ?? true}
      >
        <DialogTitle className="sr-only">Set up {BRAND.name}</DialogTitle>
        <div className="flex min-h-0 flex-col">
          <DialogHeader className="gap-4">
            <BrandWordmark className="h-6" />
            <WizardSteps
              steps={ONBOARDING_STAGES}
              currentStep={stageIndex}
              isStepDisabled={(index) => isImporting || index >= stageIndex}
              onStepChange={(index) => {
                if (isImporting || index > stageIndex) return;
                setStep(index === 0 ? "connection" : "agents");
              }}
            />
          </DialogHeader>

          <WizardPanel className="min-w-0" holdHeight={isLoadingProjects}>
            {step === "connection" ? (
              <ConnectionStep
                expandPairingInitially={!localAvailable && !hasCloudPublicConfig()}
                selectedIds={selectedIds}
                autoSelectedComputers={autoSelectedComputers.current}
                onSelectionChange={setSelection}
                onToggleEnvironment={(environmentId, checked) =>
                  setSelection((current) => {
                    const next = new Set(current ?? selectedIds);
                    if (checked) next.add(environmentId);
                    else next.delete(environmentId);
                    return next;
                  })
                }
                onContinue={() =>
                  startSetup(
                    environments
                      .filter((environment) => selectedIds.has(environment.environmentId))
                      .map((environment) => environment.environmentId),
                  )
                }
                onPaired={(environmentId) => {
                  setSelection(new Set([...selectedIds, environmentId]));
                }}
              />
            ) : step === "agents" ? (
              <AgentsStep
                environmentIds={setupIds}
                choices={brainChoices}
                onChoose={chooseOnboardingBrain}
                onContinue={(environmentId) => {
                  setProjectEnvironmentIds([environmentId]);
                  setStep("import");
                }}
              />
            ) : (
              <ImportStep
                scans={scans}
                onAddFolder={(id, folder) =>
                  setScanRoots((current) =>
                    new Map(current).set(id, [...new Set([...(current.get(id) ?? []), folder])]),
                  )
                }
                brainChoices={brainChoices}
                isImporting={isImporting}
                setIsImporting={setIsImporting}
                onDone={finish}
              />
            )}
          </WizardPanel>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

// ── Step 1: connection choice ────────────────────────────────

function ConnectionStep({
  autoSelectedComputers,
  expandPairingInitially,
  selectedIds,
  onSelectionChange,
  onToggleEnvironment,
  onContinue,
  onPaired,
}: {
  readonly autoSelectedComputers: Set<EnvironmentId>;
  readonly expandPairingInitially: boolean;
  readonly selectedIds: ReadonlySet<EnvironmentId>;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId>) => void;
  readonly onToggleEnvironment: (environmentId: EnvironmentId, checked: boolean) => void;
  readonly onContinue: () => void;
  readonly onPaired: (environmentId: EnvironmentId) => void;
}) {
  const { environments } = useEnvironments();
  const cloudEnabled = hasCloudPublicConfig();
  const directEnvironments = environments.filter(
    (environment) => !cloudEnabled || !isOnboardingRelayEnvironment(environment),
  );
  const [pairingOpen, setPairingOpen] = useState(expandPairingInitially);
  const [isPairing, setIsPairing] = useState(false);
  const ready =
    selectedIds.size > 0 &&
    [...selectedIds].every((id) =>
      environments.some(
        (environment) =>
          environment.environmentId === id && environment.connection.phase === "connected",
      ),
    );
  const continueRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (
      ready &&
      (document.activeElement === document.body ||
        document.activeElement?.getAttribute("role") === "dialog")
    ) {
      continueRef.current?.focus();
    }
  }, [ready]);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Connect your computers
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        Choose one or more computers. We’ll set up agents and projects on each.
      </p>
      {directEnvironments.length > 0 ? (
        <fieldset className="mt-5 space-y-2">
          <legend className="sr-only">Computers to set up</legend>
          {directEnvironments.map((environment) => (
            <label
              key={environment.environmentId}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-3"
            >
              <Checkbox
                checked={selectedIds.has(environment.environmentId)}
                onCheckedChange={(checked) => {
                  const next = new Set(selectedIds);
                  if (checked) next.add(environment.environmentId);
                  else next.delete(environment.environmentId);
                  onSelectionChange(next);
                }}
              />
              <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-sm font-medium break-words">
                    {environment.label}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {environment.connection.phase === "connected" ? "Connected" : "Connecting…"}
                  </span>
                </span>
                {environment.displayUrl ? (
                  <span className="mt-0.5 block text-xs break-all text-muted-foreground">
                    {environment.displayUrl}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="mt-4 space-y-2">
        {cloudEnabled ? (
          <ConnectAccountOption
            autoSelectedComputers={autoSelectedComputers}
            disabled={isPairing}
            selectedIds={selectedIds}
            onToggleEnvironment={onToggleEnvironment}
          />
        ) : null}
        <Collapsible
          open={pairingOpen}
          onOpenChange={setPairingOpen}
          className="rounded-lg border border-border bg-background"
        >
          <CollapsibleTrigger
            disabled={isPairing}
            render={
              <Button
                variant="ghost"
                className="h-auto min-h-14 w-full justify-start gap-3 px-3 py-3 text-left whitespace-normal sm:h-auto"
              />
            }
          >
            <LinkIcon className="size-4 text-muted-foreground" />
            <span className="flex-1">Add a computer</span>
            <ChevronRightIcon
              className={cn("size-4 text-muted-foreground", pairingOpen && "rotate-90")}
            />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="px-3 pb-3">
              <PairingForm
                isPairing={isPairing}
                setIsPairing={setIsPairing}
                onPaired={(environmentId) => {
                  setPairingOpen(false);
                  onPaired(environmentId);
                  requestAnimationFrame(() => continueRef.current?.focus());
                }}
              />
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </div>
      <div className="mt-6 flex items-center justify-end gap-3">
        <Button
          ref={continueRef}
          autoFocus={!expandPairingInitially}
          disabled={!ready || isPairing}
          onClick={onContinue}
        >
          Continue
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </>
  );
}

function ConnectAccountOption({
  autoSelectedComputers,
  disabled,
  selectedIds,
  onToggleEnvironment,
}: {
  readonly autoSelectedComputers: Set<EnvironmentId>;
  readonly disabled: boolean;
  readonly selectedIds: ReadonlySet<EnvironmentId>;
  readonly onToggleEnvironment: (environmentId: EnvironmentId, checked: boolean) => void;
}) {
  const { environments } = useEnvironments();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const [expanded, setExpanded] = useState(true);
  const [discoveryReady, setDiscoveryReady] = useState(false);
  const onDiscoveryReady = useCallback(() => setDiscoveryReady(true), []);

  return (
    <Collapsible
      open={expanded && !!isSignedIn && discoveryReady}
      onOpenChange={setExpanded}
      className="rounded-lg border border-border bg-background"
    >
      <CollapsibleTrigger
        disabled={disabled || !isLoaded}
        onClick={(event) => {
          if (!isSignedIn) {
            event.preventDefault();
            setExpanded(true);
            openAuthPrompt();
          }
        }}
        render={
          <Button
            variant="ghost"
            className="h-auto min-h-14 w-full justify-start gap-3 px-3 py-3 text-left whitespace-normal sm:h-auto"
          />
        }
      >
        <CloudIcon className="size-4 text-muted-foreground" />
        <span className="flex-1">{BRAND.connectName}</span>
        <span className="text-xs text-muted-foreground">
          {!isLoaded
            ? "Loading sign-in…"
            : !isSignedIn
              ? "Sign in"
              : !discoveryReady
                ? "Loading computers…"
                : null}
        </span>
        <ChevronRightIcon
          className={cn("size-4 text-muted-foreground", expanded && isSignedIn && "rotate-90")}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel keepMounted>
        <div className="px-3 pb-3">
          <div className="mb-3 space-y-1.5">
            {isSignedIn ? (
              <CloudEnvironmentConnectRows
                primaryEnvironmentId={null}
                savedEnvironments={environments}
                showSavedEnvironments
                onDiscoveryReady={onDiscoveryReady}
                selection={{ selectedIds, onChange: onToggleEnvironment, autoSelectedComputers }}
                refreshWhileEmpty
                empty={
                  <p className="py-3 text-sm text-muted-foreground">No computers linked yet.</p>
                }
              />
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            Run this on each computer you want to connect.
          </p>
          <CommandBlock command="npx t3 connect" className="mt-3" />
          <p className="mt-3 text-xs text-muted-foreground">
            Keep {BRAND.name} running. Select the computers you want to set up above.
          </p>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

// ── Step 2′: Direct pairing ──────────────────────────────────

/**
 * Register a computer in this browser using a server-minted pairing link.
 */
function PairingForm({
  isPairing,
  setIsPairing,
  onPaired,
}: {
  readonly isPairing: boolean;
  readonly setIsPairing: (value: boolean) => void;
  readonly onPaired: (environmentId: EnvironmentId) => void;
}) {
  const connectPairingEnvironment = useAtomCommand(connectPairing, { reportFailure: false });
  const [pairingUrl, setPairingUrl] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async () => {
    if (isPairing || pairingUrl.trim().length === 0) return;
    setIsPairing(true);
    setErrorMessage("");
    const result = await connectPairingEnvironment({ pairingUrl: pairingUrl.trim() });
    if (!mountedRef.current) return;
    setIsPairing(false);
    if (result._tag === "Success") {
      onPaired(result.value);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    setErrorMessage(cause instanceof Error ? cause.message : "Pairing failed.");
  };

  return (
    <>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <label className="block text-sm text-muted-foreground" htmlFor="onboarding-pairing-url">
            Pairing link
          </label>
          <Input
            id="onboarding-pairing-url"
            autoFocus
            aria-invalid={errorMessage.length > 0}
            aria-describedby={errorMessage ? "onboarding-pairing-error" : undefined}
            className="mt-2"
            size="lg"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            nativeInput
            readOnly={isPairing}
            placeholder="https://your-server:5230/pair#token=…"
            value={pairingUrl}
            onChange={(event) => setPairingUrl(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.nativeEvent.isComposing || event.keyCode === 229)
              ) {
                event.preventDefault();
              }
            }}
          />
        </div>
        {errorMessage ? (
          <div
            id="onboarding-pairing-error"
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive"
          >
            {errorMessage}
          </div>
        ) : null}
        <Collapsible>
          <div className="flex items-center justify-between gap-3">
            <CollapsibleTrigger
              type="button"
              className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronRightIcon className="size-3.5 group-data-panel-open:rotate-90" />
              Need a pairing link?
            </CollapsibleTrigger>
            <Button type="submit" disabled={isPairing || pairingUrl.trim().length === 0}>
              {isPairing ? "Pairing..." : "Pair"}
            </Button>
          </div>
          <CollapsiblePanel className="pt-3">
            <p className="text-sm text-muted-foreground">
              Run this on the computer with your code.
            </p>
            <CommandBlock command="npx t3 pair" className="mt-2" />
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Start {BRAND.name} first, or run <code className="font-mono">npx t3 serve</code>. Add{" "}
              <code className="font-mono">--tailscale</code> to use your tailnet.
            </p>
          </CollapsiblePanel>
        </Collapsible>
      </form>
    </>
  );
}

// ── Step 3: agents ───────────────────────────────────────────

const PRIMARY_AGENT_DRIVERS = ["claudeAgent", "codex", "opencode"] as const;
type OnboardingAgentDriver = (typeof PRIMARY_AGENT_DRIVERS)[number];

/**
 * A remote Brain already indexes its team's repositories; the local workspace
 * mirrors them after a connect. Local Brains start empty, so they contribute
 * nothing to preselect.
 */
function remoteBrainSources(
  workspace:
    | { readonly remote?: unknown; readonly sources: readonly { repository: string }[] }
    | undefined,
): readonly string[] | undefined {
  if (!workspace?.remote) return undefined;
  const repositories = workspace.sources.map((source) => source.repository).filter(Boolean);
  return repositories.length > 0 ? [...new Set(repositories)] : undefined;
}

/** The Brain step either creates a new local Brain or connects an existing remote one. */
type BrainSetupMode = "create" | "connect";
const BRAIN_SETUP_MODES = [
  { mode: "create", label: "Create a new Brain" },
  { mode: "connect", label: "Connect to your team Brain" },
] as const satisfies readonly { mode: BrainSetupMode; label: string }[];

/** Setup values stay fixed while provider probes refresh the surrounding cards. */
interface AgentTerminalSession {
  readonly environmentId: EnvironmentId;
  readonly driver: OnboardingAgentDriver;
  readonly providerInstanceId: ServerProvider["instanceId"];
  readonly cwd: string;
  readonly command: string;
  readonly keybindings: ServerConfig["keybindings"];
}

/**
 * Claude Code and Codex use live probe status. Install opens the built-in
 * terminal inline with the vendor's standalone installer pre-typed. The update
 * RPC can't install a binary that isn't there yet (it infers the installer from
 * the installed binary's path), and the terminal also handles the interactive
 * login that follows.
 */
function AgentsStep({
  environmentIds,
  choices,
  onChoose,
  onContinue,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly choices: ReadonlyMap<EnvironmentId, OnboardingBrainChoice>;
  readonly onChoose: (environmentId: EnvironmentId, brain: OnboardingBrainChoice) => void;
  readonly onContinue: (environmentId: EnvironmentId) => void;
}) {
  const { environments } = useEnvironments();
  const [selectedId, setSelectedId] = useState(
    environmentIds.find((id) => choices.has(id)) ?? environmentIds[0],
  );
  const activeId =
    selectedId && environmentIds.includes(selectedId) ? selectedId : environmentIds[0];
  return (
    <StepShell title="Set up your Brain">
      <Tabs.Root
        value={activeId}
        onValueChange={(value) => {
          const id = environmentIds.find((id) => id === value);
          if (id) setSelectedId(id);
        }}
      >
        {environmentIds.length > 1 ? (
          <Tabs.List
            aria-label="Brain location"
            className="mt-4 flex gap-1 rounded-lg bg-muted p-1"
          >
            {environmentIds.map((id) => (
              <Tabs.Tab
                key={id}
                value={id}
                className="rounded-md px-3 py-2 text-sm data-[active]:bg-background data-[active]:shadow-sm"
              >
                {environments.find((environment) => environment.environmentId === id)?.label ??
                  "Computer"}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        ) : null}
        {activeId ? (
          <Tabs.Panel value={activeId}>
            <ConnectedAgentsStep
              key={activeId}
              environmentId={activeId}
              choice={choices.get(activeId)}
              onChoose={onChoose}
              onContinue={onContinue}
            />
          </Tabs.Panel>
        ) : null}
      </Tabs.Root>
    </StepShell>
  );
}

/** Exported for the Brain-step behavior tests. */
export function ConnectedAgentsStep({
  environmentId,
  choice,
  onChoose,
  onContinue,
}: {
  readonly onContinue: (id: EnvironmentId) => void;
  readonly environmentId: EnvironmentId;
  readonly choice: OnboardingBrainChoice | undefined;
  readonly onChoose: (environmentId: EnvironmentId, brain: OnboardingBrainChoice) => void;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const [terminalSession, setTerminalSession] = useState<AgentTerminalSession | null>(null);

  // Re-probe on entry so freshly installed CLIs show up without a manual
  // refresh; harmless when nothing changed (single-flighted per environment).
  useEffect(() => {
    void refreshProviders({ environmentId, input: {} });
  }, [environmentId, refreshProviders]);

  const byDriver = useMemo(() => selectOnboardingProvidersByDriver(providers), [providers]);

  const updateProviderSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const executeBrain = useAtomCommand(brainCommand, { reportFailure: false });
  const [brainState, setBrainState] = useState<BrainState | null>(null);
  const [name, setName] = useState("My Brain");
  const [cli, setCli] = useState<BrainCli>("claude");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<BrainSetupMode>("create");
  const [endpoint, setEndpoint] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [readAttempt, setReadAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void executeBrain({ environmentId, input: { action: "read", metadataOnly: true } }).then(
      (result) => {
        if (!active) return;
        if (result._tag === "Success" && !result.value.error) {
          setBrainState(result.value.state);
          const available = result.value.state.clis.find((item) => item.installed);
          if (available) setCli(available.id);
        } else setError("Could not load Brains from this computer.");
      },
    );
    return () => {
      active = false;
    };
  }, [environmentId, executeBrain, readAttempt]);
  const createBrain = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await executeBrain({
        environmentId,
        input: { action: "create", name: name.trim(), cli },
      });
      if (result._tag === "Failure" || result.value.error || !result.value.createdWorkspaceId) {
        setError(
          result._tag === "Success"
            ? (result.value.error ?? "Could not create Brain. Retry.")
            : "Could not create Brain. Check the connection and retry.",
        );
        return;
      }
      setBrainState(result.value.state);
      onChoose(environmentId, { id: result.value.createdWorkspaceId, name: name.trim() });
      onContinue(environmentId);
    } finally {
      setBusy(false);
    }
  };
  /**
   * Connect mode reuses the Brain page's validation and command shape, so the
   * onboarding and settings surfaces cannot drift apart.
   */
  const connectBrain = async () => {
    const fields = { endpoint, email, password, cli };
    if (busy || !connectCloudReady(fields) || !cliReady) return;
    setBusy(true);
    setError("");
    try {
      const result = await executeBrain({ environmentId, input: connectCloudCommand(fields) });
      const response = result._tag === "Success" ? result.value : null;
      const outcome = connectCloudOutcome(response);
      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }
      setPassword("");
      if (response) setBrainState(response.state);
      const connected = response?.state.workspaces.find((item) => item.id === outcome.workspaceId);
      onChoose(environmentId, {
        id: outcome.workspaceId,
        name: connected?.name ?? endpoint.trim(),
        sources: remoteBrainSources(connected),
      });
      onContinue(environmentId);
    } finally {
      setBusy(false);
    }
  };
  const connectReady = connectCloudReady({ endpoint, email, password });
  const cliReady =
    getOnboardingProviderState(byDriver.get(cli === "claude" ? "claudeAgent" : cli)) === "ready";
  const primaryAgents = PRIMARY_AGENT_DRIVERS.map((driver) => ({
    driver,
    provider: byDriver.get(driver),
  }));
  return (
    <>
      {!choice ? (
        <div
          role="radiogroup"
          aria-label="Brain setup"
          className="mt-4 flex gap-1 rounded-lg bg-muted p-1"
        >
          {BRAIN_SETUP_MODES.map((option) => (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={mode === option.mode}
              disabled={busy}
              className={cn(
                "flex-1 rounded-md px-3 py-2 text-sm",
                mode === option.mode ? "bg-background shadow-sm" : "text-muted-foreground",
              )}
              onClick={() => {
                setMode(option.mode);
                setError("");
                setPassword("");
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      <ScrollArea
        scrollFade
        className="mt-5 h-auto max-h-[28rem] [&_[data-slot=scroll-area-scrollbar]]:opacity-100"
      >
        <section>
          {!choice ? (
            <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
              {mode === "connect"
                ? "Use a Brain your team already runs. Enter its URL or invitation link and sign in."
                : "Give it a name and choose a CLI to build its knowledge."}
            </p>
          ) : null}
          {mode === "connect" && !choice ? (
            <div className="mb-4 space-y-3">
              <label className="block space-y-2 text-sm">
                Brain URL or invitation link
                <Input
                  type="url"
                  placeholder="https://brain.example.com"
                  value={endpoint}
                  disabled={busy}
                  onChange={(event) => setEndpoint(event.target.value)}
                />
              </label>
              <label className="block space-y-2 text-sm">
                Email
                <Input
                  type="email"
                  autoComplete="username"
                  value={email}
                  disabled={busy}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label className="block space-y-2 text-sm">
                Password
                <Input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  disabled={busy}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            </div>
          ) : null}
          {choice ? (
            <p className="mb-3 text-sm text-success-foreground">
              {choice.name} is ready. Next, choose its projects.
            </p>
          ) : mode === "create" ? (
            <label className="mb-4 block space-y-2 text-sm">
              Brain name
              <Input
                value={name}
                maxLength={80}
                disabled={busy}
                placeholder="e.g. Acme platform"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          ) : null}
          {!choice ? (
            <p className="mb-2 text-sm">
              {mode === "connect"
                ? "Choose an agent to write this computer's conversation notes"
                : "Choose an agent to maintain this Brain"}
            </p>
          ) : null}
          <div className="space-y-1.5">
            {primaryAgents.map(({ driver, provider }) => (
              <div key={driver} className="flex items-center gap-2">
                {!choice ? (
                  <input
                    type="radio"
                    name={`brain-cli-${environmentId}`}
                    aria-label={`Use ${driver === "claudeAgent" ? "Claude Code" : driver} for this Brain`}
                    checked={cli === (driver === "claudeAgent" ? "claude" : driver)}
                    disabled={busy || getOnboardingProviderState(provider) !== "ready"}
                    onChange={() => setCli(driver === "claudeAgent" ? "claude" : driver)}
                  />
                ) : null}
                <div className="min-w-0 flex-1">
                  <AgentCard
                    driver={driver}
                    provider={provider}
                    terminalOpen={terminalSession?.driver === driver}
                    terminalAvailable={serverConfig !== null}
                    onOpenTerminal={async () => {
                      if (provider === undefined || serverConfig === null) return;
                      if (!provider.enabled) {
                        const settings = serverConfig.settings;
                        const result = await updateProviderSettings({
                          environmentId,
                          input: {
                            patch: buildProviderInstanceUpdatePatch({
                              settings,
                              instanceId: provider.instanceId,
                              driver: provider.driver,
                              isDefault: String(provider.instanceId) === String(provider.driver),
                              instance: {
                                ...settings.providerInstances[provider.instanceId],
                                driver: provider.driver,
                                enabled: true,
                              },
                            }),
                          },
                        });
                        if (result._tag !== "Success")
                          setError("Could not enable this agent. Retry.");
                        else await refreshProviders({ environmentId, input: {} });
                        return;
                      }
                      setTerminalSession({
                        environmentId,
                        driver,
                        providerInstanceId: provider.instanceId,
                        cwd: serverConfig.cwd,
                        command: provider.installed
                          ? resolveOnboardingProviderLoginCommand(
                              provider,
                              serverConfig.settings,
                              serverConfig.environment.platform.os,
                            )
                          : resolveOnboardingProviderInstallCommand(
                              driver,
                              serverConfig.environment.platform.os,
                            ),
                        keybindings: serverConfig.keybindings,
                      });
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          {(providers ?? [])
            .filter(
              (provider) =>
                provider.installed &&
                !PRIMARY_AGENT_DRIVERS.some((driver) => driver === provider.driver),
            )
            .map((provider) => (
              <p key={provider.instanceId} className="mt-2 text-xs text-muted-foreground">
                {getDriverOption(provider.driver)?.label ?? provider.driver}: detected for chats.
              </p>
            ))}
          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
              {!brainState ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setError("");
                    setReadAttempt((attempt) => attempt + 1);
                  }}
                >
                  Retry
                </Button>
              ) : null}
            </p>
          ) : null}
          {terminalSession !== null ? (
            <AgentInstallTerminal
              key={`${terminalSession.environmentId}:${terminalSession.providerInstanceId}:${terminalSession.driver}`}
              session={terminalSession}
              onClose={() => {
                setTerminalSession(null);
                void refreshProviders({ environmentId, input: {} });
              }}
            />
          ) : null}
        </section>
      </ScrollArea>
      <div className="mt-6 flex justify-end">
        <Button
          disabled={
            busy ||
            (!choice &&
              (mode === "connect" ? !connectReady || !cliReady : !name.trim() || !cliReady))
          }
          onClick={() =>
            choice
              ? onContinue(environmentId)
              : mode === "connect"
                ? void connectBrain()
                : void createBrain()
          }
        >
          {busy
            ? mode === "connect" && !choice
              ? "Connecting…"
              : "Creating Brain…"
            : choice
              ? "Use this Brain"
              : mode === "connect"
                ? "Connect Brain"
                : "Create Brain"}
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </>
  );
}

function AgentCard({
  driver,
  provider,
  terminalOpen,
  terminalAvailable,
  onOpenTerminal,
}: {
  readonly driver: OnboardingAgentDriver;
  readonly provider: ServerProvider | undefined;
  readonly terminalOpen: boolean;
  readonly terminalAvailable: boolean;
  readonly onOpenTerminal: () => void;
}) {
  const meta = getDriverOption(ProviderDriverKind.make(driver));
  const Icon = meta?.icon;
  const displayName = driver === "claudeAgent" ? "Claude Code" : (meta?.label ?? driver);
  const summary = getProviderSummary(provider);
  const providerState = getOnboardingProviderState(provider);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
      {Icon ? (
        <Icon className={cn("size-5 shrink-0", driver !== "claudeAgent" && "fill-foreground")} />
      ) : null}
      <div className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{displayName}</span>
        <p className="mt-0.5 text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
          {summary.headline}
          {providerState !== "ready" && summary.detail ? ` · ${summary.detail}` : ""}
        </p>
      </div>
      <div className="shrink-0">
        {providerState === "ready" ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
            <CheckIcon className="size-3.5" />
            Ready
          </span>
        ) : providerState === "checking" ? (
          <span className="text-xs text-muted-foreground">Checking...</span>
        ) : providerState === "disabled" ? (
          <Button size="xs" variant="ghost" onClick={onOpenTerminal} disabled={!terminalAvailable}>
            Enable
          </Button>
        ) : providerState === "attention" ? (
          <span className="text-xs text-muted-foreground">{summary.headline}</span>
        ) : (
          <Button
            size="xs"
            variant="ghost"
            onClick={onOpenTerminal}
            disabled={terminalOpen || !terminalAvailable}
          >
            <TerminalIcon className="size-3.5" />
            {providerState === "signIn" ? "Sign in" : "Install"}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Inline install terminal. Opens a PTY on the connected environment under a
 * synthetic onboarding thread id (terminals are keyed by free-form thread id;
 * the server validates only the cwd) and pre-types the install or login
 * command without submitting, so the user reviews and presses Enter.
 */
function AgentInstallTerminal({
  session,
  onClose,
}: {
  readonly session: AgentTerminalSession;
  readonly onClose: () => void;
}) {
  const { command, cwd, driver, environmentId, keybindings, providerInstanceId } = session;
  // Same terminal typography preference the thread drawer honors.
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const setupQueueRef = useRef(Promise.resolve());
  const setupGenerationRef = useRef(0);
  const activeSetupGenerationRef = useRef<number | null>(null);
  const [terminalId] = useState(() => `onboarding-${driver}-${randomUUID()}`);
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, AGENT_ONBOARDING_THREAD_ID),
    [environmentId],
  );
  const [setupAttempt, setSetupAttempt] = useState(0);
  const [setupState, setSetupState] = useState<
    "preparing" | "ready" | "openFailed" | "writeFailed"
  >("preparing");
  const terminalReady = setupState === "ready" || setupState === "writeFailed";

  // Keep each setup generation distinct. In Strict Mode, a canceled open can
  // finish after the replacement setup starts; it must not close or pre-type
  // into the replacement session that shares this terminal id.
  useEffect(() => {
    const generation = setupGenerationRef.current + 1;
    setupGenerationRef.current = generation;
    activeSetupGenerationRef.current = generation;
    setSetupState("preparing");

    setupQueueRef.current = setupQueueRef.current.then(async () => {
      if (activeSetupGenerationRef.current !== generation) return;
      const opened = await openTerminal({
        environmentId,
        input: {
          threadId: AGENT_ONBOARDING_THREAD_ID,
          terminalId,
          cwd,
          providerInstanceId,
        },
      });
      if (opened._tag !== "Success") {
        if (activeSetupGenerationRef.current === generation) setSetupState("openFailed");
        return;
      }

      if (activeSetupGenerationRef.current !== generation) return;

      const wrote = await writeTerminal({
        environmentId,
        input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, data: command },
      });
      if (activeSetupGenerationRef.current !== generation) return;
      setSetupState(wrote._tag === "Success" ? "ready" : "writeFailed");
    });

    // Every exit path unmounts the drawer (Done, Continue/Skip, card switch,
    // session exit), so this cleanup is the single place the PTY dies —
    // nothing is left running behind the wizard. An interrupted install is
    // re-runnable from the card.
    return () => {
      if (activeSetupGenerationRef.current === generation) {
        activeSetupGenerationRef.current = null;
      }
      setupQueueRef.current = setupQueueRef.current.then(async () => {
        await closeTerminal({
          environmentId,
          input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, deleteHistory: true },
        });
      });
    };
  }, [
    closeTerminal,
    command,
    cwd,
    environmentId,
    openTerminal,
    providerInstanceId,
    setupAttempt,
    terminalId,
    writeTerminal,
  ]);

  return (
    <div className="thread-terminal-drawer mt-4 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground">
      <div className="flex items-center justify-between border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          {setupState === "writeFailed" ? (
            <>
              Run <code className="rounded bg-muted px-1 font-mono">{command}</code> in this
              terminal.
            </>
          ) : setupState === "ready" ? (
            "Review the command, then press Enter to run it."
          ) : setupState === "openFailed" ? (
            "Could not open the setup terminal."
          ) : (
            "Preparing command..."
          )}
        </span>
        <div className="flex items-center gap-1">
          {setupState === "openFailed" ? (
            <Button size="xs" variant="ghost" onClick={() => setSetupAttempt((value) => value + 1)}>
              Retry
            </Button>
          ) : null}
          <Button size="xs" variant="ghost-muted" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <div className="h-64">
        {terminalReady ? (
          <TerminalViewport
            threadRef={threadRef}
            threadId={AGENT_ONBOARDING_THREAD_ID}
            terminalId={terminalId}
            terminalLabel={`Install ${driver}`}
            cwd={cwd}
            providerInstanceId={providerInstanceId}
            advancedTypography={advancedTypography}
            onSessionExited={onClose}
            focusRequestId={1}
            autoFocus
            visible
            resizeEpoch={0}
            drawerHeight={256}
            keybindings={keybindings}
          />
        ) : null}
      </div>
    </div>
  );
}

// ── Step 4: import ───────────────────────────────────────────

function ImportStep({
  onAddFolder,
  scans,
  brainChoices,
  isImporting,
  setIsImporting,
  onDone,
}: {
  readonly scans: ReturnType<typeof useProjectScans>;
  readonly onAddFolder: (id: EnvironmentId, folder: string) => void;
  readonly brainChoices: ReadonlyMap<EnvironmentId, OnboardingBrainChoice>;
  readonly isImporting: boolean;
  readonly setIsImporting: (value: boolean) => void;
  readonly onDone: (projectRef?: ScopedProjectRef) => Promise<boolean>;
}) {
  const { environments } = useEnvironments();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const connectBrain = useAtomCommand(brainCommand, { reportFailure: false });
  const importThreads = useAtomCommand(agentSessionImport, { reportFailure: false });
  const projects = useProjects();
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState("");
  const scanFolder = useAtomQueryRunner(agentSessionScan, { reportFailure: false, refresh: true });
  const [chosenProjects, setChosenProjects] = useState<readonly ImportCandidate[]>([]);
  const [chosenFolders, setChosenFolders] = useState<readonly string[]>([]);
  const [folderMessage, setFolderMessage] = useState("");
  const [githubRepositories, setGithubRepositories] = useState<readonly string[]>([]);
  const [importError, setImportError] = useState("");
  const [landingProject, setLandingProject] = useState<ScopedProjectRef | null>(null);
  // Keep project creation attempts separate from completed history imports so both can retry.
  const importedProjectsRef = useRef(new Map<string, ScopedProjectRef>());
  const projectsWithImportedHistoryRef = useRef(new Map<string, ScopedProjectRef>());
  const lastImportSelectionRef = useRef<ReadonlyArray<string>>([]);
  const projectAttemptsRef = useRef(
    new Map<string, { readonly projectId: ProjectId; readonly commandId: CommandId }>(),
  );
  const importGenerationRef = useRef(0);

  // Ignore command completions after leaving the import step.
  useEffect(() => {
    importGenerationRef.current += 1;
    return () => {
      importGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (
      landingProject !== null &&
      projects.some(
        (project) =>
          project.id === landingProject.projectId &&
          project.environmentId === landingProject.environmentId,
      )
    ) {
      setLandingProject(null);
      void onDone(landingProject).then((completed) => {
        if (!completed) setIsImporting(false);
      });
    }
  }, [landingProject, onDone, projects, setIsImporting]);

  const candidates: readonly ImportCandidate[] = useMemo(() => {
    const suggested = scans.flatMap((scan) =>
      (scan.data?.candidates ?? [])
        .filter((candidate) => isSuggestedBrainProject(candidate.path, chosenFolders))
        .filter(
          (candidate) =>
            !chosenProjects.some(
              (project) =>
                project.environmentId === scan.environmentId &&
                projectIsWithinFolder(candidate.path, project.path),
            ),
        )
        .map((candidate) => ({
          ...candidate,
          environmentId: scan.environmentId,
          key: onboardingProjectKey(scan.environmentId, candidate.path),
        })),
    );
    return [...chosenProjects, ...suggested];
  }, [scans, chosenFolders, chosenProjects]);
  const selectedKeys = selectedPaths;
  const selected = candidates.filter((candidate) => selectedKeys.has(candidate.key));

  /**
   * A connected remote Brain already indexes its team's repositories, so the
   * local clones of those repositories are what this computer needs set up.
   */
  const remoteSourceMatches = useMemo(
    () =>
      scans.map((scan) => {
        const choice = brainChoices.get(scan.environmentId);
        const sources = choice?.sources ?? [];
        const scanned = scan.data;
        if (sources.length === 0 || scanned === null)
          return { scan, brainId: null, matched: [], unmatched: [] as readonly string[] };
        const knownProjects = projects
          .filter((project) => project.environmentId === scan.environmentId)
          .map((project) => ({
            path: project.workspaceRoot,
            title: project.title,
            projectId: project.id,
          }));
        const chosen = chosenProjects.filter(
          (project) => project.environmentId === scan.environmentId,
        );
        return {
          scan,
          brainId: choice?.id ?? null,
          ...matchRemoteBrainSources(
            sources,
            scanned.candidates,
            [...chosen, ...knownProjects],
            chosenFolders,
          ),
        };
      }),
    [scans, brainChoices, projects, chosenProjects, chosenFolders],
  );
  // Preselect once per connected Brain; later renders must not undo unchecks.
  const preselectedBrainsRef = useRef(new Set<string>());
  useEffect(() => {
    for (const entry of remoteSourceMatches) {
      if (entry.brainId === null) continue;
      const marker = `${entry.scan.environmentId}:${entry.brainId}`;
      if (preselectedBrainsRef.current.has(marker)) continue;
      preselectedBrainsRef.current.add(marker);
      // Same shape as the "Add GitHub repository" flow: a match that resolves to a
      // registered parent project is not a scan candidate, so it must be added as a
      // chosen project or its selection would point at nothing.
      const scanned = entry.scan.data?.candidates ?? [];
      const additions: ImportCandidate[] = entry.matched
        .flatMap((match) => match.candidates)
        .map((candidate) => ({
          ...candidate,
          environmentId: entry.scan.environmentId,
          key: onboardingProjectKey(entry.scan.environmentId, candidate.path),
          repositories: scanned.filter(
            (repo) => repo.git !== null && projectIsWithinFolder(repo.path, candidate.path),
          ),
        }));
      if (additions.length === 0) continue;
      setChosenProjects((current) => {
        const existing = new Set(current.map((project) => project.key));
        return [...current, ...additions.filter((project) => !existing.has(project.key))];
      });
      setSelectedPaths((current) => new Set([...current, ...additions.map((p) => p.key)]));
    }
  }, [remoteSourceMatches]);

  /**
   * Add a picked folder as a project. `validate` lets a caller refuse folders
   * that are not what was asked for — the picker surfaces the thrown message.
   */
  const addProjectFolder = async (
    environmentId: EnvironmentId,
    folder: string,
    validate?: (found: readonly AgentSessionProjectCandidate[]) => void,
  ) => {
    const result = await scanFolder({ environmentId, input: { roots: [folder] } });
    if (result._tag !== "Success")
      throw new Error("Could not scan this folder. Try another folder.");
    const found = result.value.candidates.filter(
      (candidate) =>
        projectIsWithinFolder(candidate.path, folder) &&
        isSuggestedBrainProject(candidate.path, [folder]),
    );
    validate?.(found);
    const key = onboardingProjectKey(environmentId, folder);
    const project: ImportCandidate = {
      path: folder,
      title: folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder,
      sources: [],
      threadCount: 0,
      lastActiveAt: null,
      alreadyImported: false,
      git: found.find((item) => item.path === folder)?.git ?? null,
      environmentId,
      key,
      repositories: found.filter((item) => item.git !== null),
    };
    setChosenProjects((current) => [
      ...current.filter(
        (item) => item.environmentId !== environmentId || !projectIsWithinFolder(item.path, folder),
      ),
      project,
    ]);
    setChosenFolders((current) => [...new Set([...current, folder])]);
    setSelectedPaths((current) => new Set([...current, key]));
    setSearch("");
    setFolderMessage(`Project added: ${project.title}`);
    onAddFolder(environmentId, folder);
  };

  const finishAfterImport = () => {
    const projectRef = resolveOnboardingLandingProject(
      lastImportSelectionRef.current,
      projectsWithImportedHistoryRef.current,
      importedProjectsRef.current,
    );
    if (projectRef === undefined) {
      void onDone();
      return;
    }
    setIsImporting(true);
    setLandingProject(projectRef);
  };

  const runImport = async (selection: typeof candidates) => {
    if (isImporting) return;
    if (selection.length === 0) {
      void onDone();
      return;
    }
    setIsImporting(true);
    setImportError("");
    lastImportSelectionRef.current = selection.map((candidate) => candidate.key);
    const importGeneration = importGenerationRef.current;
    const importedProjects = importedProjectsRef.current;
    const projectAttempts = projectAttemptsRef.current;
    // Interrupted imports are neither failures nor successes — the command was
    // superseded or the environment dropped — but they still didn't land, so
    // they must not read as "imported everything". Retries skip paths that
    // already landed this session (re-creating them would only trip the
    // duplicate-root invariant and read as a failure).
    let importedProjectsCount =
      importedProjects.size > 0
        ? selection.filter((candidate) => importedProjects.has(candidate.key)).length
        : 0;
    let importedThreadCount = 0;
    let skippedThreadCount = 0;
    const refreshEnvironments = new Set<EnvironmentId>();
    for (const candidate of selection) {
      const { environmentId } = candidate;
      if (
        importGeneration !== importGenerationRef.current ||
        importedProjects !== importedProjectsRef.current
      ) {
        return;
      }
      if (importedProjects.has(candidate.key)) continue;
      let projectId = resolveOnboardingProjectId(readProjects(), environmentId, candidate);
      const workspaceId = brainChoices.get(environmentId)?.id;
      if (!workspaceId) {
        setImportError("Choose a Brain for this computer before connecting projects.");
        setIsImporting(false);
        return;
      }
      if (importGeneration !== importGenerationRef.current) return;
      if (projectId === null) {
        let attempt = projectAttempts.get(candidate.key);
        if (attempt === undefined) {
          const nextProjectId = newProjectId();
          attempt = {
            projectId: nextProjectId,
            commandId: CommandId.make(`onboarding:project:create:${nextProjectId}`),
          };
          projectAttempts.set(candidate.key, attempt);
        }
        projectId = attempt.projectId;
        const result = await createProject({
          environmentId,
          input: {
            projectId,
            commandId: attempt.commandId,
            title: candidate.title,
            workspaceRoot: candidate.path,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (
          importGeneration !== importGenerationRef.current ||
          importedProjects !== importedProjectsRef.current
        ) {
          return;
        }
        if (result._tag !== "Success") {
          if (!isAtomCommandInterrupted(result)) {
            projectAttempts.delete(candidate.key);
            refreshEnvironments.add(environmentId);
          }
          continue;
        }
      }

      {
        const connection = await connectBrain({
          environmentId,
          input: { action: "bindProject", projectId, workspaceId },
        });
        if (connection._tag === "Failure" || connection.value.error) {
          setIsImporting(false);
          setImportError(
            connection._tag === "Success" && connection.value.error
              ? `Project saved, but its Brain could not be connected: ${connection.value.error}`
              : "Project saved, but its Brain could not be connected. Retry to finish setup.",
          );
          return;
        }
      }
      const threadImportResult = await importThreads({
        environmentId,
        input: { projectId, expectedWorkspaceRoot: candidate.path },
      });
      if (
        importGeneration !== importGenerationRef.current ||
        importedProjects !== importedProjectsRef.current
      ) {
        return;
      }
      if (threadImportResult._tag === "Success") {
        importedThreadCount += threadImportResult.value.importedCount;
        skippedThreadCount += threadImportResult.value.skippedCount;
        if (threadImportResult.value.importedCount > 0) {
          projectsWithImportedHistoryRef.current.set(
            candidate.key,
            scopeProjectRef(environmentId, projectId),
          );
        }
        if (threadImportResult.value.skippedCount === 0) {
          importedProjectsCount += 1;
          importedProjects.set(candidate.key, scopeProjectRef(environmentId, projectId));
        }
      } else if (!isAtomCommandInterrupted(threadImportResult)) {
        projectAttempts.delete(candidate.key);
        refreshEnvironments.add(environmentId);
      }
    }
    for (const scan of scans) {
      if (refreshEnvironments.has(scan.environmentId)) scan.refresh();
    }
    setIsImporting(false);
    if (importedProjectsCount < selection.length) {
      if (importedThreadCount > 0 && skippedThreadCount > 0) {
        setImportError(
          `Imported ${importedThreadCount} ${importedThreadCount === 1 ? "thread" : "threads"}. ${skippedThreadCount} ${skippedThreadCount === 1 ? "thread" : "threads"} could not be imported.`,
        );
      } else if (skippedThreadCount > 0) {
        setImportError(
          `${skippedThreadCount} ${skippedThreadCount === 1 ? "thread could" : "threads could"} not be imported.`,
        );
      } else if (importedThreadCount > 0) {
        setImportError(
          `Imported ${importedThreadCount} ${importedThreadCount === 1 ? "thread" : "threads"}. Some thread history could not be imported.`,
        );
      } else {
        setImportError("Could not import thread history.");
      }
      return;
    }
    finishAfterImport();
  };

  return (
    <StepShell
      title="Which projects belong to this Brain?"
      description="Choose folders for your chats. Git repositories inside them will be indexed by your Brain."
    >
      <div className="mt-5 space-y-3">
        {scans.map((scan) => (
          <ProjectSourcePicker
            key={scan.environmentId}
            environmentId={scan.environmentId}
            disabled={isImporting}
            onFolder={(folder) => addProjectFolder(scan.environmentId, folder)}
            onGithub={async (repository) => {
              const workspaceId = brainChoices.get(scan.environmentId)?.id;
              if (!workspaceId) throw new Error("Choose a Brain first.");
              const repositoryKey = githubRepositoryKey(repository);
              if (!repositoryKey)
                throw new Error(
                  "Enter a GitHub repository URL, such as https://github.com/team/project.",
                );
              if (
                !githubRepositories.some((value) => githubRepositoryKey(value) === repositoryKey)
              ) {
                const result = await connectBrain({
                  environmentId: scan.environmentId,
                  input: { action: "import", workspaceId, repository },
                });
                if (result._tag !== "Success" || result.value.error)
                  throw new Error(
                    result._tag === "Success"
                      ? (result.value.error ?? "Could not add repository.")
                      : "Could not connect to this computer.",
                  );
                setGithubRepositories((current) => [...current, repository]);
              }
              const knownProjects = readProjects()
                .filter((project) => project.environmentId === scan.environmentId)
                .map((project) => ({
                  path: project.workspaceRoot,
                  title: project.title,
                  projectId: project.id,
                }));
              const selectedProjects = chosenProjects.filter(
                (project) => project.environmentId === scan.environmentId,
              );
              const roots = [
                ...new Set([...chosenFolders, ...knownProjects.map((project) => project.path)]),
              ];
              const refreshed = await scanFolder({
                environmentId: scan.environmentId,
                input: { roots },
              });
              if (refreshed._tag !== "Success") {
                setFolderMessage(
                  "Repository added to Brain. Local folders could not be checked; use Choose folder to connect one.",
                );
                return;
              }
              const matches = matchGithubProjects(
                repository,
                refreshed.value.candidates,
                [...selectedProjects, ...knownProjects],
                chosenFolders,
              );
              const additions: ImportCandidate[] = matches.map((candidate) => ({
                ...candidate,
                environmentId: scan.environmentId,
                key: onboardingProjectKey(scan.environmentId, candidate.path),
                repositories: refreshed.value.candidates.filter(
                  (repo) => repo.git !== null && projectIsWithinFolder(repo.path, candidate.path),
                ),
              }));
              setChosenProjects((current) => {
                const existing = new Set(current.map((project) => project.key));
                return [...current, ...additions.filter((project) => !existing.has(project.key))];
              });
              setSelectedPaths(
                (current) => new Set([...current, ...additions.map((project) => project.key)]),
              );
              setFolderMessage(
                matches.length
                  ? `Repository added to Brain. ${matches.length} matching local ${matches.length === 1 ? "project selected" : "projects selected"}.`
                  : "Repository added to Brain. No matching local project found.",
              );
            }}
          />
        ))}
        {folderMessage ? (
          <p role="status" className="text-sm text-muted-foreground">
            {folderMessage}
          </p>
        ) : null}
        {remoteSourceMatches.map((entry) =>
          entry.unmatched.length === 0 ? null : (
            <div key={entry.scan.environmentId} className="space-y-3 rounded-lg border p-3">
              <p className="text-sm font-medium">Not found locally</p>
              <p className="text-xs text-muted-foreground">
                Your Brain indexes these repositories. Choose each clone on this computer to set it
                up here too.
              </p>
              {entry.unmatched.map((repository) => (
                <div key={repository} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 break-all text-sm">{repository}</span>
                  <ProjectSourcePicker
                    environmentId={entry.scan.environmentId}
                    disabled={isImporting}
                    onFolder={(folder) =>
                      addProjectFolder(entry.scan.environmentId, folder, (found) => {
                        if (
                          !found.some((candidate) =>
                            folderMatchesRemoteSource(repository, candidate.git?.repository),
                          )
                        )
                          throw new Error(
                            `This folder is not a clone of ${repository}. Choose the folder that contains it.`,
                          );
                      })
                    }
                  />
                </div>
              ))}
            </div>
          ),
        )}
        {candidates.length > 0 ? (
          <Input
            aria-label="Search projects"
            placeholder="Search projects…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        ) : null}
        {githubRepositories.map((repository) => (
          <p key={repository} className="text-sm">
            <CheckIcon className="mr-2 inline size-4 text-success-foreground" />
            {repository}
          </p>
        ))}
      </div>
      <ScrollArea
        scrollFade
        className="mt-2 h-auto max-h-80 [&_[data-slot=scroll-area-scrollbar]]:opacity-100"
      >
        <div className="space-y-5 pr-3">
          {scans.map((scan) => {
            const scanCandidates = candidates.filter(
              (candidate) =>
                candidate.environmentId === scan.environmentId &&
                `${candidate.git?.repository ?? candidate.title} ${candidate.path}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
            );
            const label =
              environments.find((environment) => environment.environmentId === scan.environmentId)
                ?.label ?? "Computer";
            return (
              <fieldset
                key={scan.environmentId}
                className="min-w-0 space-y-0.5"
                disabled={isImporting}
              >
                {scans.length > 1 ? (
                  <legend className="mb-2 text-sm font-medium">{label}</legend>
                ) : null}
                {scan.isPending && scan.data === null ? (
                  <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                    <Spinner className="size-4" />
                    Looking for projects…
                  </div>
                ) : scan.error !== null ? (
                  <div
                    role="alert"
                    className="flex items-center justify-between gap-3 text-sm text-muted-foreground"
                  >
                    <span>Could not check projects. {scan.error}</span>
                    <Button variant="ghost" size="sm" onClick={scan.refresh}>
                      Retry
                    </Button>
                  </div>
                ) : scanCandidates.length === 0 ? (
                  <p className="py-2 text-sm text-muted-foreground">
                    {search
                      ? "No matching projects."
                      : "Choose a folder or add a GitHub repository to get started."}
                  </p>
                ) : null}
                <ImportCandidateList
                  candidates={scanCandidates}
                  selectedKeys={selectedKeys}
                  onSelectionChange={setSelectedPaths}
                />
              </fieldset>
            );
          })}
        </div>
      </ScrollArea>
      {importError ? <p className="mt-3 text-sm text-destructive">{importError}</p> : null}
      <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
        <Button
          variant="ghost-muted"
          disabled={isImporting}
          onClick={importError ? finishAfterImport : () => void onDone()}
        >
          {importError ? "Continue without the rest" : "Add projects later"}
        </Button>
        <Button
          autoFocus
          disabled={isImporting || (selected.length === 0 && githubRepositories.length === 0)}
          onClick={() => void runImport(selected)}
        >
          {isImporting ? "Connecting projects…" : "Open Brain"}
        </Button>
      </div>
    </StepShell>
  );
}

type ImportCandidate = AgentSessionProjectCandidate & {
  readonly environmentId: EnvironmentId;
  readonly key: string;
  readonly repositories?: readonly AgentSessionProjectCandidate[];
};

function ImportCandidateList({
  candidates,
  selectedKeys,
  onSelectionChange,
}: {
  readonly candidates: ReadonlyArray<ImportCandidate>;
  readonly selectedKeys: ReadonlySet<string>;
  readonly onSelectionChange: (next: ReadonlySet<string>) => void;
}) {
  return (
    <div className="divide-y rounded-lg border">
      {candidates.map((candidate) => (
        <div key={candidate.key}>
          <label className="flex cursor-pointer items-center gap-3 p-3 hover:bg-muted/40">
            <Checkbox
              checked={selectedKeys.has(candidate.key)}
              onCheckedChange={(checked) => {
                const next = new Set(selectedKeys);
                if (checked) next.add(candidate.key);
                else next.delete(candidate.key);
                onSelectionChange(next);
              }}
            />
            <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-medium">
                {candidate.title}
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                  Project
                </span>
              </span>
              <span className="block break-all text-xs text-muted-foreground">
                {candidate.path}
              </span>
            </span>
          </label>
          <div className="mb-3 ml-12 mr-3 border-l pl-4">
            {(candidate.repositories ?? (candidate.git ? [candidate] : [])).map((repo) => (
              <div key={repo.path} className="flex items-start gap-2 py-1.5 text-xs">
                <GitBranchIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block font-medium">{repo.git?.repository ?? repo.title}</span>
                  <span className="break-all text-muted-foreground">
                    {repo.path === candidate.path
                      ? "Project repository"
                      : repo.path
                          .replace(/^\/private\/tmp(?=\/|$)/, "/tmp")
                          .slice(
                            candidate.path.replace(/^\/private\/tmp(?=\/|$)/, "/tmp").length + 1,
                          )}{" "}
                    · Brain indexing
                  </span>
                </span>
              </div>
            ))}
            {(candidate.repositories ?? (candidate.git ? [candidate] : [])).length === 0 ? (
              <p className="py-1 text-xs text-muted-foreground">
                No Git repositories · Chat project only
              </p>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────

function StepShell({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      {description ? (
        <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </>
  );
}

function CommandBlock({
  command,
  className,
  prominent = false,
}: {
  readonly command: string;
  readonly className?: string;
  readonly prominent?: boolean;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: "command",
  });
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/50 font-mono",
        prominent ? "px-4 py-3.5 text-base" : "px-3 py-2.5 text-sm",
        className,
      )}
    >
      <span className="min-w-0 truncate">
        <span className="mr-2 text-muted-foreground">$</span>
        {command}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Copy command"
        onClick={() => copyToClipboard(command, undefined)}
      >
        {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}
