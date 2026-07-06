import { Shell } from "@/components/Shell";
import { AgentSession } from "@/components/AgentSession";

export const metadata = { title: "Agent session — Flow" };

export default async function AgentSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Shell>
      <AgentSession id={id} />
    </Shell>
  );
}
