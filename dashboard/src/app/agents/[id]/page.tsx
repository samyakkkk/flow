import { Shell } from "@/components/Shell";
import { AgentSession } from "@/components/AgentSession";

import { CloudTaskRun } from "@/components/CloudAgents";

export const metadata = { title: "Agent session — Flow" };

export default async function AgentSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Shell>
      {id.startsWith("cloud-") ? <CloudTaskRun id={id.slice(6)} /> : <AgentSession key={id} id={id} />}
    </Shell>
  );
}
