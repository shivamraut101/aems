import type { Metadata } from "next";
import { Inter } from "next/font/google";

import { AppShell } from "@/components/app-shell";
import { Providers } from "@/components/providers";

import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "AEMS — Workforce Intelligence",
  description: "Activity, productivity and device insight for company-owned devices.",
};

/**
 * `AppShell` wraps everything and steps aside for /login itself, so the sign-in
 * screen renders without a sidebar full of destinations a signed-out person cannot
 * reach. Route protection is `middleware.ts`; this only decides what is drawn.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
