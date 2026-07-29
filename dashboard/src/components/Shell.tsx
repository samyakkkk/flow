"use client";
import { useState } from "react";
import { Nav } from "./Nav";

export function Shell({ children }: { children: React.ReactNode }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="flex flex-col md:flex-row h-screen overflow-hidden bg-cream">
      {/* Mobile top header bar */}
      <div className="md:hidden flex items-center justify-between px-4 py-3 bg-paper border-b border-line z-30 flex-shrink-0">
        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
            style={{ background: "var(--accent)", border: "1px solid var(--line)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="12" cy="12" r="3" fill="var(--ink)" />
              <circle cx="5" cy="7" r="1.6" fill="var(--ink)" opacity="0.6" />
              <circle cx="19" cy="7" r="1.6" fill="var(--ink)" opacity="0.6" />
              <circle cx="5" cy="17" r="1.6" fill="var(--ink)" opacity="0.6" />
              <circle cx="19" cy="17" r="1.6" fill="var(--ink)" opacity="0.6" />
              <path d="M12 12L5 7M12 12L19 7M12 12L19 17" stroke="var(--ink)" strokeWidth="0.8" opacity="0.35" />
            </svg>
          </div>
          <span
            style={{ fontFamily: "var(--font-display)", fontWeight: 500, fontSize: 17 }}
            className="text-ink tracking-tight"
          >
            Flow
          </span>
        </div>
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="p-2 rounded-md hover:bg-sand text-ink transition-colors focus:outline-none"
          aria-label="Toggle Navigation Menu"
        >
          {mobileMenuOpen ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          )}
        </button>
      </div>

      {/* Navigation overlay for mobile drawer */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-ink/30 z-40 md:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Nav Sidebar / Mobile Drawer */}
      <div
        className={`fixed inset-y-0 left-0 z-50 transform transition-transform duration-200 ease-in-out md:relative md:translate-x-0 ${
          mobileMenuOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Nav onCloseMobile={() => setMobileMenuOpen(false)} />
      </div>

      <main
        className="flex-1 overflow-y-auto relative flex flex-col p-4 sm:p-6 md:p-9 max-w-full md:max-w-[calc(100vw-220px)]"
        style={{
          background: "var(--cream)",
        }}
      >
        {children}
      </main>
    </div>
  );
}
