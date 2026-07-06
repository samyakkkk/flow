"use client";
import { Nav } from "./Nav";
import { AskBar } from "./AskBar";

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-cream">
      <Nav />
      <main
        className="flex-1 overflow-y-auto relative"
        style={{
          background: "var(--cream)",
          padding: "36px 40px 100px", // bottom padding for the floating Ask bar
          maxWidth: "calc(100vw - 220px)",
        }}
      >
        {children}
      </main>
      <AskBar />
    </div>
  );
}
