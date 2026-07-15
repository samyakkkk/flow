import type { Metadata } from "next";
import { Lora, Inter, Space_Mono } from "next/font/google";
import { headers } from "next/headers";
import { PROJECT_HEADER } from "@/lib/config";
import { ProjectProvider } from "@/lib/useProject";
import "./globals.css";

const lora = Lora({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-lora", display: "swap" });
const inter = Inter({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-inter", display: "swap" });
const spaceMono = Space_Mono({ subsets: ["latin"], weight: ["400"], variable: "--font-space-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Flow",
  description: "Flow — the ground truth of your codebase",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Set by proxy.ts when it strips the /p/<name> URL prefix; null on
  // deployment-level pages (login).
  const project = (await headers()).get(PROJECT_HEADER);
  return (
    <html lang="en" className={`h-full ${lora.variable} ${inter.variable} ${spaceMono.variable}`}>
      <body className="min-h-full" style={{ background: "var(--cream)", color: "var(--text)" }}>
        <ProjectProvider name={project}>{children}</ProjectProvider>
      </body>
    </html>
  );
}
