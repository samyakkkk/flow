import { Shell } from "@/components/Shell";
import { AgentsView } from "@/components/AgentsView";

export const metadata = { title: "Agents — Flow" };

export default function AgentsPage() {
  return (
    <Shell>
      <AgentsView />
    </Shell>
  );
}
