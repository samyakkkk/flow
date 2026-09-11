import { useCallback, useRef } from "react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { brainCommand } from "../../state/brain";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useProjectBrainChoice } from "./useProjectBrainChoice";

/** Persist the first-send choice on the project's server, across chats and clients. */
export function useProjectBrainSetup() {
  const { chooseBrain, brainChoiceDialog } = useProjectBrainChoice();
  const execute = useAtomCommand(brainCommand, { reportFailure: false });
  const pending = useRef(false);
  const ensureBrainChoice = useCallback(
    async (environmentId: EnvironmentId, projectId: ProjectId, title: string) => {
      if (pending.current) return false;
      if (
        appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId))
          ?.projectBrainSetupComplete[projectId]
      )
        return true;
      pending.current = true;
      try {
        const read = await execute({
          environmentId,
          input: { action: "read", metadataOnly: true, projectId },
        });
        if (read._tag === "Success" && read.value.state.configuredProjectIds?.includes(projectId))
          return true;
        const connected =
          read._tag === "Success" &&
          read.value.state.workspaces.some((brain) => brain.projectIds?.includes(projectId));
        if (!connected) {
          const choice = await chooseBrain(environmentId, title, projectId);
          if (!choice) return false;
          const result = await execute({
            environmentId,
            input: { action: "bindProject", projectId, workspaceId: choice.workspaceId },
          });
          if (result._tag === "Failure" || result.value.error) {
            toastManager.add({
              type: "error",
              title: "Could not save brain choice",
              description:
                result._tag === "Success"
                  ? (result.value.error ?? undefined)
                  : "Check the connection and retry.",
            });
            return false;
          }
        }
        return true;
      } catch {
        toastManager.add({
          type: "error",
          title: "Could not save brain choice",
          description: "Please retry. Your message has not been sent.",
        });
        return false;
      } finally {
        pending.current = false;
      }
    },
    [chooseBrain, execute],
  );
  return { ensureBrainChoice, brainSetupDialog: brainChoiceDialog };
}
