import type { ReactNode } from "react";

export interface BrainUiEntity {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly description: string;
  readonly source?: string | undefined;
  readonly properties?: Readonly<Record<string, string>> | undefined;
}

export interface BrainUiEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

export interface BrainUiKnowledge {
  readonly entities: readonly BrainUiEntity[];
  readonly edges: readonly BrainUiEdge[];
}

export interface BrainUiSnapshot extends BrainUiKnowledge {
  readonly id: string;
  readonly name: string;
  readonly sourceCount: number;
}

export interface BrainWorkspaceViewProps {
  readonly snapshot: BrainUiSnapshot;
  readonly hasBrain: boolean;
  readonly isIndexing: boolean;
  readonly loading: boolean;
  readonly connectionNotice: { readonly title: string; readonly description: string } | null;
  readonly error: string | null;
  readonly toolbar: ReactNode;
  readonly indexing?: ReactNode;
  readonly sources?: ReactNode;
  readonly connectedProjects?: ReactNode;
  readonly docs?: ReactNode;
  readonly skills?: ReactNode;
  readonly onCreate?: () => void;
}

export interface BrainUiDocumentSummary {
  readonly id: string;
  readonly kind: "notes" | "doc" | "memory" | "skill";
  readonly name: string;
  readonly description: string;
  readonly revision: number;
  readonly lifecycle: "standing" | "temporal" | "issue";
  readonly status: "active" | "resolved" | "superseded";
  readonly updatedAt: number;
  readonly observedAt?: number;
}

export interface BrainUiDocument extends BrainUiDocumentSummary {
  readonly text: string;
}

export interface BrainSourceCard {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: ReactNode;
  readonly status?: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly onList?: () => void;
}
