import type { Metadata } from "next";
import { Lora, Inter, Space_Mono } from "next/font/google";
import "./globals.css";

const lora = Lora({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-lora", display: "swap" });
const inter = Inter({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-inter", display: "swap" });
const spaceMono = Space_Mono({ subsets: ["latin"], weight: ["400"], variable: "--font-space-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Flow",
  description: "Flow — the ground truth of your codebase",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`h-full ${lora.variable} ${inter.variable} ${spaceMono.variable}`}>
      <body className="min-h-full" style={{ background: "var(--cream)", color: "var(--text)" }}>
        {children}
      </body>
    </html>
  );
}
