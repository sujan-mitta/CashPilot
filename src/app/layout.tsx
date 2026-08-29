import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { CashPilotProvider } from "@/context/CashPilotContext";
import { ChromeShell } from "@/components/ChromeShell";
import { ToastProvider } from "@/components/ui/Toast";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { ErrorBoundary } from "@/components/ErrorBoundary";

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
    // suppressHydrationWarning is required and narrow: the inline script below
    // stamps data-theme on this element before React hydrates, so the server
    // markup and the client DOM legitimately differ on this one attribute.
    <html lang="en" className="h-full" suppressHydrationWarning>
      <head>
        {/* Runs before first paint. Without it, a light-mode operator sees the
            dark default flash on every navigation. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-full flex flex-col`}
      >
        <ErrorBoundary>
          <ToastProvider>
            <CashPilotProvider>
              <ChromeShell>{children}</ChromeShell>
            </CashPilotProvider>
          </ToastProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
