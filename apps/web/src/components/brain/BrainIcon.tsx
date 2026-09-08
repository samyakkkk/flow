import {
  AtomIcon,
  BrainCircuitIcon,
  LightbulbIcon,
  NetworkIcon,
  OrbitIcon,
  SparklesIcon,
} from "lucide-react";
import { projectIconColorClassName } from "../../projectIconColors";
import { cn } from "../../lib/utils";

const identities = [
  { icon: BrainCircuitIcon, color: "violet" },
  { icon: OrbitIcon, color: "blue" },
  { icon: NetworkIcon, color: "teal" },
  { icon: SparklesIcon, color: "amber" },
  { icon: AtomIcon, color: "pink" },
  { icon: LightbulbIcon, color: "orange" },
] as const;

/** Stable across renames and clients without fetching a separate image. */
export function BrainIcon({ id, className }: { id: string; className?: string }) {
  let hash = 2_166_136_261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16_777_619);
  const { icon: Icon, color } = identities[(hash >>> 0) % identities.length]!;
  return (
    <Icon
      aria-hidden="true"
      className={cn("size-4 shrink-0", projectIconColorClassName(color), className)}
    />
  );
}
