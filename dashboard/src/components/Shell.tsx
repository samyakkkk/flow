"use client";
import { Nav } from "./Nav";
import { ProposalDialog } from "./ProposalDialog";

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-cream">
      <Nav />
      <main
        className="flex-1 overflow-y-auto relative flex flex-col"
        style={{
          background: "var(--cream)",
          padding: "36px 40px 48px",
          maxWidth: "calc(100vw - 220px)",
        }}
      >
        {children}
      </main>
      <ProposalDialog />
    </div>
  );
}
