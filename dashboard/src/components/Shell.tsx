"use client";
import { Nav } from "./Nav";

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-cream">
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
    </div>
  );
}
