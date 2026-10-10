import type { Metadata } from "next";
import "./globals.css";
import { PlatformShell } from "@/components/platform-shell";

export const metadata: Metadata = {
  title: "Main Investigation Platform",
  description: "Central operations hub for site, wallet, transaction, and evidence intelligence.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased"><PlatformShell>{children}</PlatformShell></body>
    </html>
  );
}
