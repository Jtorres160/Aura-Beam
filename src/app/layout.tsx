import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSessionProvider } from "@/components/providers/session-provider";
import { CookieConsent } from "@/components/cookie-consent";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Aura — AI Trading Card Scanner",
    template: "%s | Aura",
  },
  description:
    "The fastest way to identify and value your trading cards. Scan Pokémon, Magic: The Gathering, and Yu-Gi-Oh! cards instantly with AI-powered recognition and live market pricing.",
  keywords: [
    "trading cards",
    "card scanner",
    "Pokémon cards",
    "Magic The Gathering",
    "Yu-Gi-Oh",
    "card pricing",
    "card collection",
    "TCG",
  ],
  authors: [{ name: "Aura" }],
  openGraph: {
    title: "Aura — AI Trading Card Scanner",
    description: "Scan, identify, and value your trading cards instantly.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f0a1a" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full flex flex-col font-sans">
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <AppSessionProvider>
            <TooltipProvider>
              {children}
              <CookieConsent />
            </TooltipProvider>
          </AppSessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
