import { createFileRoute } from "@tanstack/react-router";
import { LiveBrainPage } from "../components/brain/LiveBrainPage";
import { readBrainSelection, saveBrainSelection } from "../brain/selection";

function BrainRoute() {
  const search = Route.useSearch();
  const remembered =
    search.brain === undefined && search.environment === undefined ? readBrainSelection() : {};
  const navigate = Route.useNavigate();
  return (
    <LiveBrainPage
      selectedEnvironmentId={search.environment ?? remembered.environment ?? null}
      selectedWorkspaceId={search.brain ?? remembered.brain ?? null}
      openSettings={search.settings === true}
      onSettingsClosed={() => {
        if (search.settings)
          void navigate({
            search: { brain: search.brain, environment: search.environment },
            replace: true,
          });
      }}
      onSelectionChange={(brain, environment) => {
        saveBrainSelection(brain, environment);
        void navigate({
          search: {
            brain: brain ?? undefined,
            environment: environment ?? undefined,
          },
        });
      }}
    />
  );
}

export const Route = createFileRoute("/brain")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { brain: string | undefined; environment: string | undefined; settings?: true } => ({
    brain: typeof search.brain === "string" ? search.brain : undefined,
    environment: typeof search.environment === "string" ? search.environment : undefined,
    // Deep link from a chat's notes card straight into Brain settings.
    ...(search.settings === true || search.settings === "true" ? { settings: true } : {}),
  }),
  component: BrainRoute,
});
