import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { CashPilotProvider } from "@/context/CashPilotContext";
import { ChromeShell } from "@/components/ChromeShell";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CashPilot | AI Cash Intervention Agent",
  description: "AI-powered payment-centric cash runway intervention controller",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-full flex flex-col`}
      >
        <CashPilotProvider>
          <ChromeShell>{children}</ChromeShell>
        </CashPilotProvider>
      </body>
    </html>
  );
}
