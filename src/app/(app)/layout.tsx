"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ScanLine, Library, LineChart, Settings,
  Shield, LogOut, ChevronLeft, ChevronRight, Bell
} from "lucide-react";
import { useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { ScannerProvider, useScannerState } from "@/components/providers/scanning-context";

// Collector's Instrument IA: the scanner is the front door, the
// collection is the archive, insights hold the market view, settings
// hold everything administrative. Search and Watchlist remain routable,
// reached from Collection and Insights respectively.
const navItems = [
  { icon: ScanLine, label: "Scanner", href: "/scanner" },
  { icon: Library, label: "Collection", href: "/collection" },
  { icon: LineChart, label: "Insights", href: "/insights" },
  { icon: Settings, label: "Settings", href: "/settings" },
];

const bottomItems = [
  { icon: Bell, label: "Notifications", href: "/notifications" },
  { icon: Shield, label: "Admin", href: "/admin" },
];

function AppLayoutInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [collapsed, setCollapsed] = useState(false);
  const { isActivelyScanningOrProcessing } = useScannerState();

  return (
    <div className="flex h-dvh-screen overflow-hidden bg-background">
      {/* Desktop Sidebar */}
      <aside
        className={cn(
          "hidden md:flex flex-col border-r border-border bg-sidebar transition-all duration-300 shrink-0",
          collapsed ? "w-[72px]" : "w-[240px]"
        )}
      >
        {/* Wordmark */}
        <div className="flex items-center h-16 px-4 border-b border-border">
          <Link href="/scanner" className="flex items-center overflow-hidden px-1">
            <span className="font-heading text-2xl leading-none whitespace-nowrap">
              {collapsed ? "A" : "Aura"}
            </span>
          </Link>
        </div>

        {/* Nav items */}
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto no-scrollbar">
          {navItems.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link key={item.href} href={item.href}>
                <div
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 h-10 text-sm transition-colors duration-200",
                    isActive
                      ? "bg-accent text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/60"
                  )}
                >
                  <item.icon className="h-[18px] w-[18px] shrink-0" />
                  {!collapsed && <span className="whitespace-nowrap">{item.label}</span>}
                </div>
              </Link>
            );
          })}
        </nav>

        <Separator />

        {/* Bottom nav items */}
        <div className="p-3 space-y-1">
          {bottomItems.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link key={item.href} href={item.href}>
                <div
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 h-10 text-sm transition-colors duration-200",
                    isActive
                      ? "bg-accent text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/60"
                  )}
                >
                  <item.icon className="h-[18px] w-[18px] shrink-0" />
                  {!collapsed && <span className="whitespace-nowrap">{item.label}</span>}
                </div>
              </Link>
            );
          })}
        </div>

        {/* User */}
        <div className="p-3 border-t border-border">
          <div className="flex items-center gap-3 rounded-lg px-3 py-2">
            <Avatar className="h-8 w-8 shrink-0">
              <AvatarFallback className="bg-accent text-foreground text-xs font-semibold">
                {session?.user?.name?.charAt(0) || "U"}
              </AvatarFallback>
            </Avatar>
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{session?.user?.name || "Guest User"}</p>
                <p className="text-xs text-muted-foreground truncate">{session?.user?.email || "guest@aura.gg"}</p>
              </div>
            )}
            {!collapsed && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground"
                onClick={() => signOut({ callbackUrl: "/login" })}
              >
                <LogOut className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        {/* Collapse toggle */}
        <div className="p-2 border-t border-border">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(!collapsed)}
            className="w-full h-8 text-muted-foreground hover:text-foreground"
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <main className="flex-1 overflow-y-auto custom-scrollbar pb-20 md:pb-0">
          {children}
        </main>

        {/* Mobile bottom navigation — hidden while actively scanning to maximize screen space */}
        {!isActivelyScanningOrProcessing && (
          <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-background border-t border-border safe-area-bottom">
            <div className="flex items-center justify-around h-16">
              {navItems.map((item) => {
                const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
                return (
                  <Link key={item.href} href={item.href} className="flex flex-col items-center gap-1 px-3 py-2">
                    <item.icon
                      className={cn(
                        "h-5 w-5 transition-colors",
                        isActive ? "text-foreground" : "text-muted-foreground"
                      )}
                    />
                    <span
                      className={cn(
                        "text-[10px] font-medium transition-colors",
                        isActive ? "text-foreground" : "text-muted-foreground"
                      )}
                    >
                      {item.label}
                    </span>
                  </Link>
                );
              })}
            </div>
          </nav>
        )}
      </div>
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <ScannerProvider>
      <AppLayoutInner>{children}</AppLayoutInner>
    </ScannerProvider>
  );
}
