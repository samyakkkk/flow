import { AudioLines, FileText, Folder, Github, Layers, MessageSquare } from "lucide-react";
import { BrainSourceCatalog } from "./BrainSourceCatalog.tsx";
import type { BrainSourceCard } from "./types.ts";

export function BrainIntegrationCatalog({ brainName, title = "Sources", github, folder, extensions = [] }: {
  brainName: string;
  title?: string;
  github: { onConnect: () => void; onList: () => void };
  folder?: { description: string; onConnect: () => void; onList: () => void };
  extensions?: readonly BrainSourceCard[];
}) {
  return <BrainSourceCatalog title={title} description={`Add the code and context that contribute to ${brainName}.`} cards={[
    { id: "github", name: "GitHub Repos", description: "Repositories and branches", icon: <Github size={20} />, actionLabel: "Connect", onAction: github.onConnect, onList: github.onList },
    ...(folder ? [{ id: "folder", name: "Local Folder", description: folder.description, icon: <Folder size={20} />, actionLabel: "Browse", onAction: folder.onConnect, onList: folder.onList }] : []),
    { id: "linear", name: "Linear", description: "Issues and project specs", icon: <Layers size={20} /> },
    { id: "fireflies", name: "Fireflies.ai", description: "Meeting transcripts", icon: <AudioLines size={20} /> },
    { id: "notes", name: "Meeting Notes", description: "Notes and decisions", icon: <FileText size={20} /> },
    { id: "slack", name: "Slack Bot", description: "Ask your brain in Slack", icon: <MessageSquare size={20} /> },
  ].map((card) => extensions.find((extension) => extension.id === card.id) ?? card).concat(extensions.filter((extension) => !["github", "folder", "linear", "fireflies", "notes", "slack"].includes(extension.id)))} />;
}
