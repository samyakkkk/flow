import { Shell } from "@/components/Shell";
import { AgentSessionConductor } from "@/components/AgentSessionConductor";

export const metadata = { title: "Agent UI Lab — Flow" };

export default async function LabPage() {
  return (
    <Shell>
      <AgentSessionConductor />
    </Shell>
  );
}
