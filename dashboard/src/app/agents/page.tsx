import { Shell } from "@/components/Shell";
import { AgentsView } from "@/components/AgentsView";
import { LocalExecutionCard } from "@/components/LocalExecutionCard";

export const metadata = { title: "Agents — Flow" };

export default function AgentsPage() {
  return (
    <Shell>
      <LocalExecutionCard />
      <AgentsView />
    </Shell>
  );
}
