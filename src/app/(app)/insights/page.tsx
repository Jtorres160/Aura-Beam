"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  ArrowUpRight, ArrowDownRight, ArrowRight, ScanLine, Bell, Loader2
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PortfolioChart } from "@/components/charts/portfolio-chart";

function timeAgo(dateString: string) {
  const diff = Date.now() - new Date(dateString).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function InsightsPage() {
  const { data: session } = useSession();
  const [dashboardData, setDashboardData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!session?.user?.id || !(session as any).accessToken) return;

    fetch(`/api/dashboard`)
      .then((res) => res.json())
      .then((json) => {
        if (json.success) {
          setDashboardData(json.data);
        }
      })
      .catch((err) => console.error("Failed to fetch insights:", err))
      .finally(() => setIsLoading(false));
  }, [session]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[50vh]">
        <Loader2 className="h-8 w-8 text-muted-foreground animate-spin" />
      </div>
    );
  }

  const stats = dashboardData?.stats || { collectionValue: 0, cardsOwned: 0 };
  const recentScans = dashboardData?.recentScans || [];
  const priceMovers = dashboardData?.priceMovers || [];

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      {/* Header: collection value is the headline, not a widget */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
            Collection value
          </p>
          <p className="font-heading text-4xl sm:text-5xl mt-2 tabular-nums">
            ${stats.collectionValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            {stats.cardsOwned.toLocaleString()} {stats.cardsOwned === 1 ? "card" : "cards"} in your collection
          </p>
        </div>
        <Link href="/notifications" aria-label="Notifications">
          <Button variant="ghost" size="icon" className="text-muted-foreground">
            <Bell className="h-4 w-4" />
          </Button>
        </Link>
      </div>

      {/* Portfolio chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Value over time</CardTitle>
        </CardHeader>
        <CardContent className="pb-4">
          <PortfolioChart data={dashboardData?.portfolioHistory || []} />
        </CardContent>
      </Card>

      {/* Two column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Scans */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Recent scans</CardTitle>
              <Link
                href="/scanner"
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                Open scanner <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          </CardHeader>
          <CardContent className="pb-4">
            <div className="space-y-3">
              {recentScans.length === 0 ? (
                <div className="text-center py-6 text-sm text-muted-foreground">
                  No scans yet. Try scanning a card!
                </div>
              ) : (
                recentScans.map((scan: any) => (
                  <div key={scan.id} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="h-12 w-9 card-frame bg-muted flex items-center justify-center shrink-0">
                        {scan.imageUrl ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img src={scan.imageUrl} alt={scan.name} className="w-full h-full object-cover" />
                        ) : (
                          <ScanLine className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{scan.name}</p>
                        <p className="text-xs text-muted-foreground">{scan.set} · {scan.game}</p>
                      </div>
                    </div>
                    <div className="text-right shrink-0 ml-3">
                      <p className="text-sm font-semibold tabular-nums">${scan.price?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
                      <p className="text-xs text-muted-foreground">{timeAgo(scan.createdAt)}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* Price Movers */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Price movers</CardTitle>
              <Link
                href="/watchlist"
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                Watchlist <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          </CardHeader>
          <CardContent className="pb-4">
            <div className="space-y-3">
              {priceMovers.length === 0 ? (
                <div className="text-center py-6 text-sm text-muted-foreground">
                  Add cards to your collection to see price movers!
                </div>
              ) : priceMovers.map((mover: any) => (
                <div key={mover.name} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{mover.name}</p>
                    <p className="text-xs text-muted-foreground">{mover.game}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-3">
                    <Badge
                      variant="secondary"
                      className={`text-xs tabular-nums ${mover.trend === "up" ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}
                    >
                      {mover.trend === "up" ? <ArrowUpRight className="h-3 w-3 mr-0.5" /> : <ArrowDownRight className="h-3 w-3 mr-0.5" />}
                      {mover.percent}
                    </Badge>
                    <span className="text-sm font-medium w-16 text-right tabular-nums">{mover.change}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
